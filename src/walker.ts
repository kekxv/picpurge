
import { readdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import { Dirent } from 'fs';

// Define image extensions constant
const imageExtensions = [
  '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.webp', '.cr2',
];

export async function* findImageFiles(dir: string): AsyncGenerator<string> {
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const res = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        yield* findImageFiles(res);
      } else if (imageExtensions.includes(extname(res).toLowerCase())) {
        yield res;
      }
    }
  } catch (error) {
    console.error(`[ERROR] Error scanning directory '${dir}':`, error);
  }
}
