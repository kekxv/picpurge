import { Command } from 'commander';
import { connectDb, getDb } from './database.js';
import { findImageFiles } from './walker.js';
import { promises as fs, constants } from 'fs'; // Import 'constants' for access check
import { basename, join, extname, dirname } from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import imghash from 'imghash';
import hamming from 'hamming-distance';
import { startServer } from './server.js';
import ExifParser from 'exif-parser';

// Import chalk for colorful output
import chalk from 'chalk';
// Import ora for loading indicators
import ora from 'ora';
// Import cli-table3 for table output
import Table from 'cli-table3';

// Define image extensions constant for use in main.ts
const imageExtensions = [
  '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.webp', '.cr2',
];

// Function to convert hex to binary string
function hexToBinary(hex: string): string {
  return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

async function processImage(filePath: string) {
  const spinner = ora({
    text: `Processing ${basename(filePath)}`,
    spinner: 'clock'
  }).start();
  
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
      
      spinner.info(chalk.yellow(`Moved ${basename(filePath)} to Recycle bin (size < 10KB).`));
      return;
    }

    const md5 = createHash('md5').update(fileBuffer).digest('hex');
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
        spinner.warn(chalk.yellow(`Could not parse EXIF data for ${basename(filePath)}: ${message}`));
        // exifData will remain null, and processing will continue
      }
    }

    let create_date = exifData?.tags?.DateTimeOriginal;
    if (!create_date) {
        create_date = stat.birthtime;
    }

    const thumbnailDir = join(process.cwd(), 'thumbnails');
    await fs.mkdir(thumbnailDir, { recursive: true });
    const thumbnailPath = join(thumbnailDir, `${basename(filePath, extname(filePath))}.webp`);
    await sharp(fileBuffer).resize(320, 320).webp().toFile(thumbnailPath);

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
    spinner.succeed(chalk.green(`Processed ${basename(filePath)}.`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.fail(chalk.red(`Error processing ${basename(filePath)}: ${message}`));
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

async function sortImages(rootPath: string) {
  const db = getDb();
  const images: any[] = await db.all('SELECT * FROM images WHERE is_duplicate = FALSE');

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
    const newPath = join(
      rootPath,
      image.device_make || 'UnknownMake',
      image.device_model || 'UnknownModel',
      image.lens_model || 'UnknownLens',
      newFileName
    );

    await fs.mkdir(dirname(newPath), { recursive: true });
    try {
      // Try rename first (more efficient for same device)
      await fs.rename(image.file_path, newPath);
    } catch (renameErr) {
      // If rename fails (e.g., cross-device), use copy + unlink
      await fs.copyFile(image.file_path, newPath);
      await fs.unlink(image.file_path);
    }
    await db.run('UPDATE images SET file_path = ? WHERE id = ?', newPath, image.id);
    console.log(chalk.green(`[INFO] Moved ${basename(image.file_path)} to ${newPath}`));
  }
  console.log(chalk.blue('[INFO] Image sorting complete.'));
}

async function main() {
  const program = new Command();
  program
    .version('1.0.0')
    .description('Image Organization Tool')
    .option('--sort', 'Sort images into directories based on metadata')
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

      console.log(chalk.blue('[INFO] Starting image processing...'));
      const processSpinner = ora({
        text: 'Processing images',
        spinner: 'clock'
      }).start();
      
      let processedCount = 0;
      for (const file of allImageFiles) {
        await processImage(file);
        processedCount++;
        processSpinner.text = `Processing images (${processedCount}/${allImageFiles.length})`;
      }
      
      processSpinner.succeed(chalk.green('[INFO] All images processed.'));

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

      const similarSpinner = ora({
        text: 'Finding similar images',
        spinner: 'clock'
      }).start();
      
      await findSimilarImages();
      similarSpinner.succeed(chalk.blue('[INFO] Similarity analysis complete.'));

      if (options.sort) {
        console.log(chalk.blue('[INFO] Sorting enabled. Starting image sorting...'));
        // Use the first provided path as the root for sorting
        await sortImages(allPaths[0]);
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

          // Optionally, clean up thumbnails directory
          const thumbnailDir = join(process.cwd(), 'thumbnails');
          try {
            await fs.access(thumbnailDir); // Check if directory exists
            // Note: This will remove the directory and all its contents.
            // Make sure this is the desired behavior.
            // await fs.rm(thumbnailDir, { recursive: true, force: true });
            // console.log(`[INFO] Thumbnails directory '${thumbnailDir}' removed.`);
          } catch (err) {
            // Directory does not exist, which is fine.
            // console.log(`[INFO] Thumbnails directory '${thumbnailDir}' does not exist or could not be accessed.`);
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
