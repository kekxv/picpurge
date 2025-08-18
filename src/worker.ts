import { parentPort } from 'worker_threads';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import imghash from 'imghash';
import ExifParser from 'exif-parser';
import piexif from 'piexifjs';
import { join, basename, dirname } from 'path';

if (!parentPort) {
  throw new Error('This file should be run as a worker thread.');
}

async function processImage(filePath: string, recyclePath: string) {
  try {
    sharp.cache(false); // Disable libvips cache for this worker
    const stat = await fs.stat(filePath);
    if (stat.size < 10 * 1024 && recyclePath) {
      const destPath = join(recyclePath, basename(filePath));
      await fs.mkdir(dirname(destPath), { recursive: true });
      try {
        await fs.rename(filePath, destPath);
      } catch (renameErr) {
        await fs.copyFile(filePath, destPath);
        await fs.unlink(filePath);
      }
      parentPort?.postMessage({ filePath, moved: true });
      return;
    }

    const fileBuffer = await fs.readFile(filePath);
    let bufferForHashing = fileBuffer;

    const lowerCaseFilePath = filePath.toLowerCase();
    if (lowerCaseFilePath.endsWith('.jpg') || lowerCaseFilePath.endsWith('.jpeg')) {
      try {
        const data = fileBuffer.toString('binary');
        const exifRemoved = piexif.remove(data);
        bufferForHashing = Buffer.from(exifRemoved, 'binary');
      } catch (e) {
        // Not a valid JPEG with EXIF, or another error.
      }
    }

    const md5 = createHash('md5').update(bufferForHashing).digest('hex');
    const phash = await imghash.hash(bufferForHashing as any);

    const sharpInstance = sharp(fileBuffer);
    const metadata = await sharpInstance.metadata();

    let exifData = null;
    if (metadata.exif) {
        try {
            const parser = ExifParser.create(metadata.exif);
            exifData = parser.parse();
        } catch (e) {
            // ignore exif parsing errors
        }
    }

    const result = {
      md5: `${md5}-${fileBuffer.length}`,
      size: fileBuffer.length,
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

parentPort.on('message', (data) => {
  if (typeof data === 'object' && data.filePath) {
    processImage(data.filePath, data.recyclePath);
  } else {
    // For backward compatibility or simple messages
    processImage(data, '');
  }
});


