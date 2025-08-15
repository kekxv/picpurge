import { parentPort } from 'worker_threads';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import imghash from 'imghash';
import ExifParser from 'exif-parser';

if (!parentPort) {
  throw new Error('This file should be run as a worker thread.');
}

async function processImage(filePath: string) {
  try {
    const fileBuffer = await fs.readFile(filePath);

    const md5 = createHash('md5').update(fileBuffer).digest('hex');
    const phash = await imghash.hash(filePath);

    const sharpInstance = sharp(fileBuffer);
    const metadata = await sharpInstance.metadata();

    let exifData = null;
    if (metadata.exif) {
      const parser = ExifParser.create(metadata.exif);
      exifData = parser.parse();
    }

    const result = {
      md5,
      phash,
      width: metadata.width,
      height: metadata.height,
      deviceMake: exifData?.tags?.Make,
      deviceModel: exifData?.tags?.Model,
      lensModel: exifData?.tags?.LensModel,
      createDate: exifData?.tags?.DateTimeOriginal,
    };

    parentPort?.postMessage({ filePath, result });
  } catch (error) {
    parentPort?.postMessage({ filePath, error: (error as Error).message });
  }
}

parentPort.on('message', (filePath: string) => {
  processImage(filePath);
});