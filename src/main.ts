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
              // Explicitly trigger flush if buffer is full
              if (imageInsertBuffer.length >= BATCH_SIZE && !flushPromise) {
                flushInsertBufferInternal();
              }
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


// Helper function to move a file to the recycle directory
async function moveFileToRecycle(filePath: string, recyclePath: string, db: any): Promise<boolean> {
  try {
    const fileName = basename(filePath);
    const destPath = join(recyclePath, fileName);

    await fs.mkdir(dirname(destPath), { recursive: true });

    try {
      await fs.rename(filePath, destPath);
    } catch (renameErr) {
      // If rename fails (e.g., cross-device link), copy and then delete original
      await fs.copyFile(filePath, destPath);
      await fs.unlink(filePath);
    }

    // Update database: mark as recycled
    await db.run('UPDATE images SET is_recycled = TRUE WHERE file_path = ?', filePath);
    return true;
  } catch (error) {
    console.error(chalk.red(`[ERROR] Failed to move ${filePath} to recycle bin: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  }
}

async function findDuplicates(autoRecycleDuplicates: boolean, recyclePath: string) {
  const db = getDb();
  // Find all MD5 hashes that appear more than once
  const duplicateMd5s = await db.all('SELECT md5 FROM images GROUP BY md5 HAVING COUNT(*) > 1');

  let duplicatePairsCount = 0;
  let recycledCount = 0;

  for (const { md5 } of duplicateMd5s) {
    // For each duplicate MD5, get all images with that MD5, ordered by ID
    // We need file_path here for recycling
    const imagesWithSameMd5 = await db.all('SELECT id, file_path FROM images WHERE md5 = ? ORDER BY id ASC', md5);

    if (imagesWithSameMd5.length > 1) {
      const masterImageId = imagesWithSameMd5[0].id;
      // Mark all subsequent images as duplicates of the first one
      for (let i = 1; i < imagesWithSameMd5.length; i++) {
        const duplicateImage = imagesWithSameMd5[i];
        await db.run('UPDATE images SET is_duplicate = ?, duplicate_of = ? WHERE id = ?', true, masterImageId, duplicateImage.id);
        duplicatePairsCount++;

        if (autoRecycleDuplicates) {
          const moved = await moveFileToRecycle(duplicateImage.file_path, recyclePath, db);
          if (moved) {
            recycledCount++;
          }
        }
      }
    }
  }

  console.log(chalk.blue(`[INFO] Found ${chalk.bold(duplicatePairsCount.toString())} duplicate image pairs.`));
  if (autoRecycleDuplicates) {
    console.log(chalk.blue(`[INFO] Automatically recycled ${chalk.bold(recycledCount.toString())} duplicate images.`));
  }
}

async function findSimilarImages() {
  const db = getDb();
  const images: any[] = await db.all('SELECT id, phash, image_width, image_height FROM images');
  const phashThreshold = 3;
  const sizeThreshold = 0.2; // Stricter size difference: 20%
  const aspectRatioTolerance = 0.1; // 10% tolerance for aspect ratio

  for (let i = 0; i < images.length; i++) {
    const image1 = images[i];
    if (!image1.phash || !image1.image_width || !image1.image_height) continue;
    const similar = [];
    const aspectRatio1 = image1.image_width / image1.image_height;

    for (let j = i + 1; j < images.length; j++) {
      const image2 = images[j];
      if (!image2.phash || !image2.image_width || !image2.image_height) continue;

      const aspectRatio2 = image2.image_width / image2.image_height;

      // Pre-filter: Check aspect ratio similarity first
      if (Math.abs(aspectRatio1 - aspectRatio2) / Math.max(aspectRatio1, aspectRatio2) > aspectRatioTolerance) {
        continue; // Aspect ratios are too different, skip pHash comparison
      }

      // Pre-filter: Check size similarity (ratio of areas)
      const area1 = image1.image_width * image1.image_height;
      const area2 = image2.image_width * image2.image_height;
      const sizeRatio = Math.min(area1, area2) / Math.max(area1, area2);
      const sizeDifference = 1 - sizeRatio;

      if (sizeDifference > sizeThreshold) {
        continue; // Sizes are too different, skip pHash comparison
      }

      // Calculate phash distance only if pre-filters pass
      const phashDistance = hamming(hexToBinary(image1.phash), hexToBinary(image2.phash));

      if (phashDistance <= phashThreshold) {
        similar.push(image2.id);
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
    .option('--recycle-path <path>', 'Specify the path for the Recycle directory.')
    .option('--auto-recycle-duplicates', 'Automatically move all but one duplicate image to the recycle directory.') // New option
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

      await findDuplicates(options.autoRecycleDuplicates, recyclePath);
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