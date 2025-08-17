import { Command } from 'commander';
import { connectDb, getDb } from './database.js';
import { findImageFiles } from './walker.js';
import { promises as fs, constants, createReadStream } from 'fs'; // Import 'constants' for access check
import { basename, join, extname, dirname } from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import imghash from 'imghash';
import hamming from 'hamming-distance';
import { startServer } from './server.js';
import ExifParser from 'exif-parser';
import os from 'os';

// Import chalk for colorful output
import chalk from 'chalk';
// Import ora for loading indicators
import ora from 'ora';
// Import cli-table3 for table output
import Table from 'cli-table3';
// Import cli-progress for progress bar
import cliProgress from 'cli-progress';

// Define image extensions constant for use in main.ts
const imageExtensions = [
  '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.webp', '.cr2',
];

// Function to convert hex to binary string
function hexToBinary(hex: string): string {
  return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

async function processImage(filePath: string, multibar: cliProgress.MultiBar) {
  try {
    const fileBuffer = await fs.readFile(filePath);
    const stat = await fs.stat(filePath);

    if (stat.size < 10 * 1024) {
      const recycleDir = join(process.cwd(), 'Recycle');
      await fs.mkdir(recycleDir, { recursive: true });
      const destPath = join(recycleDir, basename(filePath));

      try {
        // Try rename first (more efficient for same device)
        await fs.rename(filePath, destPath);
      } catch (renameErr) {
        // If rename fails (e.g., cross-device), use copy + unlink
        await fs.copyFile(filePath, destPath);
        await fs.unlink(filePath);
      }

      const message = chalk.yellow(`Moved ${basename(filePath)} to Recycle bin (size < 10KB).`);
      const messageBar = multibar.create(1, 1, { format: message });
      multibar.remove(messageBar);
      return;
    }

    const md5 = `${createHash('md5').update(fileBuffer).digest('hex')}-${fileBuffer.length}`;
    const phash = await imghash.hash(filePath);

    const sharpInstance = sharp(fileBuffer);
    const metadata = await sharpInstance.metadata();

    let exifData = null;
    if (metadata.exif) {
      try {
        const parser = ExifParser.create(metadata.exif);
        exifData = parser.parse();
      } catch (exifError) {
        const message = exifError instanceof Error ? exifError.message : String(exifError);
        const formattedMessage = chalk.yellow(`Could not parse EXIF data for ${basename(filePath)}: ${message}`);
        const messageBar = multibar.create(1, 1, { format: formattedMessage });
        multibar.remove(messageBar);
        // exifData will remain null, and processing will continue
      }
    }

    let create_date = exifData?.tags?.DateTimeOriginal;
    if (!create_date) {
        create_date = stat.birthtime;
    }

    // Generate thumbnail in memory
    const thumbnailBuffer = await sharp(fileBuffer).resize(320, 320).webp().toBuffer();

    // Store thumbnail in memory
    const thumbnailPath = `memory://${md5}`;
    // Add to memory store for server to access
    const { addThumbnailToMemory } = await import('./server.js');
    addThumbnailToMemory(md5, thumbnailBuffer);

    const db = getDb();
    await db.run(
      'INSERT OR IGNORE INTO images (file_path, file_name, file_size, md5, image_width, image_height, device_make, device_model, lens_model, create_date, phash, thumbnail_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      filePath,
      basename(filePath),
      stat.size,
      md5,
      metadata.width,
      metadata.height,
      exifData?.tags?.Make,
      exifData?.tags?.Model,
      exifData?.tags?.LensModel,
      create_date,
      phash,
      thumbnailPath
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const formattedMessage = chalk.red(`Error processing ${basename(filePath)}: ${message}`);
    const messageBar = multibar.create(1, 1, { format: formattedMessage });
    multibar.remove(messageBar);
  }
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
  const sizeThreshold = 0.05; // 5% difference in size allowed

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

      let allImageFiles: string[] = [];
      const scanSpinner = ora({
        text: 'Scanning for image files',
        spinner: 'clock'
      }).start();

      for (const path of allPaths) {
        try {
          const stats = await fs.stat(path);
          if (stats.isDirectory()) {
            const imageFiles = await findImageFiles(path);
            allImageFiles = [...allImageFiles, ...imageFiles];
          } else if (stats.isFile() && imageExtensions.includes(extname(path).toLowerCase())) {
            // If it's a single file and it's an image, add it to the list
            allImageFiles.push(path);
          } else {
            console.warn(chalk.yellow(`[WARN] Path '${path}' is neither a directory nor a recognized image file. Skipping.`));
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

        const progressBar = multibar.create(allImageFiles.length, 0, { filename: "N/A" });

        for (const file of allImageFiles) {
          progressBar.update({ filename: basename(file) });
          await processImage(file, multibar);
          progressBar.increment();
        }

        // multibar.stop(); // Keep multibar active for sorting progress
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
