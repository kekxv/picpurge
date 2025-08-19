import { Command } from 'commander';
import { connectDb, getDb } from './database.js';
import { findImageFiles } from './walker.js';
import { promises as fs } from 'fs';
import { basename, join, extname, dirname } from 'path';
import sharp from 'sharp';
import hamming from 'hamming-distance';
import { startServer } from './server.js';
import os from 'os';
import readline from 'readline';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import http from 'http'; // Import http module

// Import chalk for colorful output
import chalk from 'chalk';
// Import ora for loading indicators
import ora from 'ora';
// Import cli-table3 for table output
import Table from 'cli-table3';
// Import cli-progress for progress bar
import cliProgress from 'cli-progress';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Define image extensions constant for use in main.ts
const imageExtensions = [
  '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.webp', '.cr2',
];

// Function to convert hex to binary string
function hexToBinary(hex: string): string {
  return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

const BATCH_SIZE = 500;
const imageInsertBuffer: any[] = [];
let flushPromise: Promise<void> | null = null;
let flushIntervalId: NodeJS.Timeout | null = null;

async function runProcessing(imageFiles: AsyncGenerator<string>, totalFiles: number, multibar: cliProgress.MultiBar, recyclePath: string) {
  const numWorkers = os.cpus().length > 1 ? os.cpus().length - 1 : 1;
  console.log(chalk.blue(`[INFO] Using ${numWorkers} worker threads.`));

  const db = getDb();
  const progressBar = multibar.create(totalFiles, 0, { filename: "N/A" });
  let processedCount = 0;

  // Function to flush the buffer
  async function flushInsertBufferInternal() {
    if (imageInsertBuffer.length === 0) return;
    if (flushPromise) { // If a flush is already in progress, wait for it
      await flushPromise;
      if (imageInsertBuffer.length === 0) return; // Check again after waiting
    }

    const currentBatch = imageInsertBuffer.splice(0); // Take all current items
    if (currentBatch.length === 0) return;

    const currentFlushPromise = (async () => {
      await db.run('BEGIN TRANSACTION');
      try {
        for (const imageData of currentBatch) {
          await db.run(
            'INSERT OR IGNORE INTO images (file_path, file_name, file_size, md5, image_width, image_height, device_make, device_model, lens_model, create_date, phash, thumbnail_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            imageData.filePath,
            imageData.fileName,
            imageData.size,
            imageData.md5,
            imageData.width,
            imageData.height,
            imageData.deviceMake,
            imageData.deviceModel,
            imageData.lensModel,
            imageData.createDate,
            imageData.phash,
            imageData.thumbnailPath
          );
        }
        await db.run('COMMIT');
      } catch (err) {
        console.error(chalk.red(`[ERROR] Error during batch insert: ${err}`));
        await db.run('ROLLBACK');
      } finally {
        flushPromise = null; // Reset promise
      }
    })();
    flushPromise = currentFlushPromise;
    await currentFlushPromise;
  }

  // Start periodic flushing
  flushIntervalId = setInterval(() => {
    if (imageInsertBuffer.length > 0 && !flushPromise) {
      flushInsertBufferInternal();
    }
  }, 100); // Flush every 100ms if there's data

  return new Promise<void>((resolve, reject) => {
    const workers = new Set<Worker>();
    let activeWorkerCount = 0; // Track active workers

    const processFile = async (filePath: string) => {
      activeWorkerCount++;
      const worker = new Worker(join(__dirname, 'worker.js'));
      workers.add(worker);

      worker.on('message', async (message) => {
        if (message.filePath) {
            if (message.moved) {
              const formattedMessage = chalk.yellow(`Moved ${basename(message.filePath)} to Recycle bin (size < 10KB).`);
              const messageBar = multibar.create(1, 1, { format: formattedMessage });
              multibar.remove(messageBar);
            } else if (message.error) {
              const formattedMessage = chalk.red(`Error processing ${basename(message.filePath)}: ${message.error}`);
              const messageBar = multibar.create(1, 1, { format: formattedMessage });
              multibar.remove(messageBar);
            } else if (message.result) {
              const { filePath, result } = message;
              const { md5, size, phash, width, height, deviceMake, deviceModel, lensModel, createDate } = result;

              const stat = await fs.stat(filePath);
              let create_date = createDate || stat.birthtime;

              let thumbnailPath: string | null = null;
            try {
              const thumbnailBuffer = await sharp(filePath).resize(320, 320).webp().toBuffer();
              const { addThumbnailToMemory } = await import('./server.js');
              thumbnailPath = `memory://${md5}`;
              addThumbnailToMemory(md5, thumbnailBuffer);
            } catch (thumbnailError) {
              const formattedMessage = chalk.yellow(`[WARN] Could not generate thumbnail for ${basename(filePath)}: ${thumbnailError instanceof Error ? thumbnailError.message : String(thumbnailError)}`);
              const messageBar = multibar.create(1, 1, { format: formattedMessage });
              multibar.remove(messageBar);
              // thumbnailPath remains null
            }

              imageInsertBuffer.push({
                filePath,
                fileName: basename(filePath),
                size,
                md5,
                width,
                height,
                deviceMake,
                deviceModel,
                lensModel,
                createDate: create_date,
                phash,
                thumbnailPath,
              });
            }
            processedCount++;
            progressBar.update(processedCount, { filename: basename(message.filePath) });
        }
        
        worker.terminate();
        workers.delete(worker);
        activeWorkerCount--;

        // Introduce a small delay to reduce CPU usage
        await new Promise(resolve => setTimeout(resolve, 1));

        const next = await imageFiles.next();
        if (!next.done) {
          processFile(next.value);
        } else if (activeWorkerCount === 0) { // All workers finished
          clearInterval(flushIntervalId!); // Stop periodic flushing
          await flushInsertBufferInternal(); // Final flush
          resolve();
        }
      });

      worker.on('error', async (err) => {
        const formattedMessage = chalk.red(`Worker error for ${filePath}: ${err.message}`);
        const messageBar = multibar.create(1, 1, { format: formattedMessage });
        multibar.remove(messageBar);
        worker.terminate();
        workers.delete(worker);
        activeWorkerCount--;

        const next = await imageFiles.next();
        if (!next.done) {
          processFile(next.value);
        } else if (activeWorkerCount === 0) { // All workers finished
          clearInterval(flushIntervalId!); // Stop periodic flushing
          await flushInsertBufferInternal(); // Final flush
          resolve();
        }
      });

      worker.postMessage({ filePath, recyclePath });
    };

    (async () => {
        for (let i = 0; i < numWorkers; i++) {
            const next = await imageFiles.next();
            if (next.done) break;
            processFile(next.value);
        }
    })();
  });
}


async function findDuplicates() {
  const db = getDb();
  const duplicates = await db.all(
    'SELECT a.id as id1, b.id as id2 FROM images a, images b WHERE a.md5 = b.md5 AND a.id < b.id'
  );

  for (const row of duplicates) {
    await db.run('UPDATE images SET is_duplicate = ?, duplicate_of = ? WHERE id = ?', true, row.id1, row.id2);
  }

  console.log(chalk.blue(`[INFO] Found ${chalk.bold(duplicates.length.toString())} duplicate image pairs.`));
}

async function findSimilarImages() {
  const db = getDb();
  // Get images with more metadata for better comparison
  const images: any[] = await db.all('SELECT id, phash, image_width, image_height FROM images');
  // Use a stricter threshold to reduce false positives
  const phashThreshold = 3; // Reduced from 5 to 3 for stricter matching

  // For size comparison, we'll use a stricter threshold
  const sizeThreshold = 0.5; // 50% difference in size allowed

  for (let i = 0; i < images.length; i++) {
    const image1 = images[i];
    if (!image1.phash || !image1.image_width || !image1.image_height) continue;
    const similar = [];
    for (let j = i + 1; j < images.length; j++) {
      const image2 = images[j];
      if (!image2.phash || !image2.image_width || !image2.image_height) continue;

      // Calculate phash distance
      const phashDistance = hamming(hexToBinary(image1.phash), hexToBinary(image2.phash));

      // Only consider size similarity if phash distance is already reasonably close
      if (phashDistance <= phashThreshold) {
        // Calculate size similarity (ratio of areas)
        const area1 = image1.image_width * image1.image_height;
        const area2 = image2.image_width * image2.image_height;
        const sizeRatio = Math.min(area1, area2) / Math.max(area1, area2);
        const sizeDifference = 1 - sizeRatio;

        // Add to similar list only if size difference is within threshold
        if (sizeDifference <= sizeThreshold) {
          similar.push(image2.id);
        }
      }
    }
    if (similar.length > 0) {
      await db.run('UPDATE images SET similar_images = ? WHERE id = ?', JSON.stringify(similar), image1.id);
    }
  }

  console.log(chalk.blue('[INFO] Similarity analysis complete.'));
}

async function sortImages(rootPath: string, destinationPath?: string, multibar?: cliProgress.MultiBar) {
  const db = getDb();
  const images: any[] = await db.all('SELECT * FROM images WHERE is_duplicate = FALSE');

  let sortProgressBar: cliProgress.SingleBar | undefined;
  if (multibar) {
    sortProgressBar = multibar.create(images.length, 0, { filename: "N/A", task: "Sorting" });
  }

  for (const image of images) {
    const createDate = image.create_date ? new Date(image.create_date) : new Date();
    const year = createDate.getFullYear();
    const month = (createDate.getMonth() + 1).toString().padStart(2, '0');
    const day = createDate.getDate().toString().padStart(2, '0');
    const hours = createDate.getHours().toString().padStart(2, '0');
    const minutes = createDate.getMinutes().toString().padStart(2, '0');
    const seconds = createDate.getSeconds().toString().padStart(2, '0');

    const sequence = image.id.toString().padStart(6, '0');
    const ext = extname(image.file_path);

    const newFileName = `${year}${month}${day}${hours}${minutes}${seconds}.${sequence}${ext}`;
    const targetDir = destinationPath ? destinationPath : rootPath; // Use destinationPath if provided

    // --- MODIFICATION START ---
    // Change directory structure to Year/Month
    const yearDir = year.toString();
    const monthDir = month; // month is already padded
    const newBaseDir = join(targetDir, yearDir, monthDir);
    // --- MODIFICATION END ---

    const newPath = join(
      newBaseDir, // Use the new base directory
      newFileName
    );

    await fs.mkdir(dirname(newPath), { recursive: true });

    if (destinationPath) {
      // If destinationPath is provided, copy the file
      await fs.copyFile(image.file_path, newPath);
      if (sortProgressBar) {
        sortProgressBar.update({ filename: basename(image.file_path), task: "Copying" });
      }
      // Do NOT update database file_path as original is not moved
    } else {
      // Otherwise, move/rename the file (original behavior)
      try {
        await fs.rename(image.file_path, newPath);
      } catch (renameErr) {
        await fs.copyFile(image.file_path, newPath);
        await fs.unlink(image.file_path);
      }
      await db.run('UPDATE images SET file_path = ? WHERE id = ?', newPath, image.id);
      if (sortProgressBar) {
        sortProgressBar.update({ filename: basename(image.file_path), task: "Moving" });
      }
    }
    if (sortProgressBar) {
      sortProgressBar.increment();
    }
  }
  if (sortProgressBar) {
    sortProgressBar.stop();
    await new Promise((resolve)=>{
      setTimeout(()=>resolve(true),1000);
    })
  }
  console.log(chalk.blue('[INFO] Image sorting complete.'));
}

async function main() {
  const program = new Command();
  program
    .version('1.0.0')
    .description('Image Organization Tool')
    .option('--sort [path]', 'Sort images into directories based on metadata. Optionally provide a destination path to copy sorted images instead of moving them.')
    .option('-p, --port <port>', 'Port to start the server on', '3000')
    .option('--recycle-path <path>', 'Specify the path for the Recycle directory.') // New option
    .argument('[paths...]', 'Path(s) to the directory or file(s) to scan for images.')
    .action(async (paths, options) => {
      // Check if paths are provided via arguments or --path option
      const allPaths = [...paths]; // paths from arguments

      if (allPaths.length === 0) {
        console.error(chalk.red('[ERROR] No paths provided. Please specify at least one path.'));
        program.outputHelp();
        process.exit(1);
      }

      console.log(chalk.blue(`[INFO] Scanning paths: ${chalk.bold(allPaths.join(', '))}`));

      await connectDb();
      console.log(chalk.green('[INFO] Database connected.'));

      // Handle recycle path
      let recyclePath = options.recyclePath;
      if (!recyclePath) {
        const defaultRecyclePath = join(process.cwd(), 'Recycle');
        console.log(chalk.yellow(`[WARN] Recycle directory not specified. Defaulting to: ${defaultRecyclePath}`));
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        const answer = await new Promise<string>(resolve => {
          rl.question('Continue with this path? (y/N): ', resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          console.log(chalk.red('[INFO] Exiting.'));
          process.exit(0);
        }
        recyclePath = defaultRecyclePath;
      }
      console.log(chalk.blue(`[INFO] Using Recycle directory: ${recyclePath}`));

      const scanSpinner = ora({
        text: 'Scanning for image files',
        spinner: 'clock'
      }).start();

      const allImageFiles: string[] = [];
      for (const path of allPaths) {
          try {
              const stats = await fs.stat(path);
              if (stats.isDirectory()) {
                  for await (const file of findImageFiles(path)) {
                      allImageFiles.push(file);
                  }
              } else if (stats.isFile() && imageExtensions.includes(extname(path).toLowerCase())) {
                  allImageFiles.push(path);
              }
          } catch (err) {
              console.error(chalk.red(`[ERROR] Error accessing path '${path}':`), err);
          }
      }

      scanSpinner.succeed(chalk.blue(`Found ${chalk.bold(allImageFiles.length.toString())} image files.`));

      let multibar: cliProgress.MultiBar | undefined;

      if (allImageFiles.length > 0) {
        console.log(chalk.blue('[INFO] Starting image processing...'));

        multibar = new cliProgress.MultiBar({
          format: `Processing | ${chalk.cyan('{bar}')} | {percentage}% || {value}/{total} Files || Current: {filename}`,
          barCompleteChar: '\u2588',
          barIncompleteChar: '\u2591',
          hideCursor: true,
          clearOnComplete: true,
        });
        
        const imageFileGenerator = (async function*() {
            for (const file of allImageFiles) {
                yield file;
            }
        })();

        await runProcessing(imageFileGenerator, allImageFiles.length, multibar, recyclePath);

        multibar.stop();
        console.log(chalk.green('[INFO] All images processed.'));
      } else {
        console.log(chalk.yellow('[INFO] No images to process.'));
      }

      // Create a table for duplicate statistics
      const duplicatesSpinner = ora({
        text: 'Finding duplicates',
        spinner: 'clock'
      }).start();

      await findDuplicates();
      duplicatesSpinner.succeed();

      const db = getDb();
      const duplicates = await db.all(
        'SELECT a.id as id1, b.id as id2 FROM images a, images b WHERE a.md5 = b.md5 AND a.id < b.id'
      );

      // Display duplicate statistics in a table
      const duplicatesTable = new Table({
        head: [chalk.blue('Statistic'), chalk.blue('Value')],
        style: { head: [], border: [] }
      });

      duplicatesTable.push(
        [chalk.bold('Total Images'), (await db.get('SELECT COUNT(*) as count FROM images')).count],
        [chalk.bold('Duplicate Pairs'), duplicates.length],
        [chalk.bold('Unique Images'), (await db.get('SELECT COUNT(*) as count FROM images WHERE is_duplicate = FALSE')).count]
      );

      console.log(duplicatesTable.toString());
      console.log("");

      const similarSpinner = ora({
        text: 'Finding similar images',
        spinner: 'clock'
      }).start();

      await findSimilarImages();
      similarSpinner.succeed(chalk.blue('[INFO] Similarity analysis complete.'));

      if (options.sort) {
        console.log(chalk.blue('[INFO] Sorting enabled. Starting image sorting...'));
        // options.sort will be true if no path is provided, or the path string if provided
        const sortDestinationPath = typeof options.sort === 'string' ? options.sort : undefined;
        // Use the first provided path as the root for sorting if no destination path is given
        const sortRootPath = allPaths[0];
        // Pass the multibar instance to sortImages
        await sortImages(sortRootPath, sortDestinationPath, multibar);
      }

      // Set the port if provided
      if (options.port) {
        process.env.PORT = options.port;
      }

      startServer();

      // Handle process exit to clean up
      const exitHandler = async (exitCode: number) => {
        console.log(chalk.blue(`[INFO] Exiting with code ${exitCode}. Cleaning up...`));
        try {
          // Clean up database
          const db = getDb();
          if (db) {
            await db.close();
            console.log(chalk.green('[INFO] Database connection closed.'));
          }

        } catch (err) {
          console.error('[ERROR] Error during cleanup:', err);
        }
        process.exit(exitCode);
      };

      // Listen for exit events
      process.on('exit', (code) => exitHandler(code));
      process.on('SIGINT', () => exitHandler(130)); // Ctrl+C
      process.on('SIGTERM', () => exitHandler(143)); // Termination signal
      process.on('SIGUSR1', () => exitHandler(1)); // Custom signal 1
      process.on('SIGUSR2', () => exitHandler(1)); // Custom signal 2
      process.on('uncaughtException', async (err) => {
        console.error(chalk.red('[ERROR] Uncaught Exception:'), err);
        await exitHandler(1);
      });
    });

  program.parse(process.argv);
}

main().catch((err) => {
  console.error('[ERROR] An unexpected error occurred:', err);
});