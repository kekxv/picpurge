
import { readdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import { Dirent } from 'fs';

// Define image extensions constant
const imageExtensions = [
  '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.webp', '.cr2',
];

export async function findImageFiles(dir: string): Promise<string[]> {
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      dirents.map((dirent: Dirent) => {
        const res = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          return findImageFiles(res);
        }
        if (imageExtensions.includes(extname(res).toLowerCase())) {
          return res;
        }
        return [];
      })
    );
    return Array.prototype.concat(...files);
  } catch (error) {
    console.error(`[ERROR] Error scanning directory '${dir}':`, error);
    return []; // Return empty array on error to prevent crashing
  }
}
