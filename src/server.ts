import express, { Request, Response } from 'express';
import { getDb } from './database.js';
import { promises as fs } from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import { join, basename, extname } from 'path';

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use('/thumbnails', express.static(join(process.cwd(), 'thumbnails')));
app.use(express.static(join(process.cwd(), 'src')));

app.get('/', (req: Request, res: Response) => {
  res.sendFile(join(process.cwd(), 'src', 'index.html'));
});

app.get('/api/images', async (req: Request, res: Response) => {
  const db = getDb();
  const allImages: any[] = await db.all('SELECT * FROM images');

  function parseCreateDate(create_date: any): Date | null {
    if (!create_date) {
        return null;
    }
    if (create_date instanceof Date) {
        return create_date;
    }
    if (typeof create_date === 'number') {
        if (create_date < 1e11) {
            return new Date(create_date * 1000);
        }
        return new Date(create_date);
    }
    if (typeof create_date === 'string') {
        let dateStr = create_date;
        if (/^\d{4}:\d{2}:\d{2}/.test(dateStr)) {
            dateStr = dateStr.substring(0, 10).replace(/:/g, '-') + dateStr.substring(10);
        }
        const parsedDate = new Date(dateStr);
        if (!isNaN(parsedDate.getTime())) {
            return parsedDate;
        }
    }
    return null;
  }

  function getSortKey(image: any): string | number {
    const date = parseCreateDate(image.create_date);
    if (date) {
        return date.getTime();
    }
    return `${image.device_make || ''}${image.device_model || ''}${image.lens_model || ''}`;
  }

  const duplicateGroups: { [key: string]: any[] } = {};
  allImages.forEach(img => {
    if (img.is_duplicate && img.duplicate_of !== null && img.duplicate_of !== undefined) {
      const masterImage = allImages.find(m => m.id === img.duplicate_of);
      if (masterImage) {
        const masterId = masterImage.id.toString();
        if (!duplicateGroups[masterId]) {
          duplicateGroups[masterId] = [masterImage];
        }
        duplicateGroups[masterId].push(img);
      }
    }
  });

  const similarGroups: { [key: string]: any[] } = {};
  const similarRelationships: { [id: number]: number[] } = {};
  
  allImages.forEach(img => {
    if (img.similar_images && img.similar_images !== 'null') {
      const similarIds = JSON.parse(img.similar_images);
      similarRelationships[img.id] = similarIds;
      
      similarIds.forEach((similarId: number) => {
        if (!similarRelationships[similarId]) {
          similarRelationships[similarId] = [];
        }
        if (!similarRelationships[similarId].includes(img.id)) {
          similarRelationships[similarId].push(img.id);
        }
      });
    }
  });
  
  const visited = new Set<number>();
  Object.keys(similarRelationships).forEach(idStr => {
    const id = parseInt(idStr);
    if (visited.has(id)) return;
    
    const queue: number[] = [id];
    const group: number[] = [];
    
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      
      visited.add(currentId);
      group.push(currentId);
      
      const neighbors = similarRelationships[currentId] || [];
      neighbors.forEach(neighborId => {
        if (!visited.has(neighborId)) {
          queue.push(neighborId);
        }
      });
    }
    
    if (group.length > 1) {
      const groupKey = group.sort((a, b) => a - b).join('-');
      similarGroups[groupKey] = group.map(groupId => 
        allImages.find(img => img.id === groupId)
      ).filter(img => img !== undefined) as any[];
    }
  });

  const uniqueImages = allImages.filter(img => {
    const isNotDuplicate = !img.is_duplicate;
    const isNotInAnySimilarGroup = !Object.values(similarGroups).flat().some(s => s.id === img.id);
    return isNotDuplicate && isNotInAnySimilarGroup;
  });

  uniqueImages.sort((a, b) => {
    const keyA = getSortKey(a);
    const keyB = getSortKey(b);
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  });

  const sortedDuplicateGroupKeys = Object.keys(duplicateGroups).sort((a, b) => {
    const groupA = duplicateGroups[a];
    const groupB = duplicateGroups[b];
    if (!groupA || !groupB || groupA.length === 0 || groupB.length === 0) {
        return 0;
    }
    const masterA = groupA[0];
    const masterB = groupB[0];
    const keyA = getSortKey(masterA);
    const keyB = getSortKey(masterB);
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  });

  const sortedSimilarGroupKeys = Object.keys(similarGroups).sort((a, b) => {
    const groupA = similarGroups[a];
    const groupB = similarGroups[b];
    if (!groupA || !groupB || groupA.length === 0 || groupB.length === 0) {
        return 0;
    }
    const firstImageA = groupA[0];
    const firstImageB = groupB[0];
    const keyA = getSortKey(firstImageA);
    const keyB = getSortKey(firstImageB);
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  });

  const sortedDuplicateGroups = sortedDuplicateGroupKeys.map(key => duplicateGroups[key]);
  const sortedSimilarGroups = sortedSimilarGroupKeys.map(key => similarGroups[key]);

  res.json({
    totalImages: allImages.length,
    duplicateGroupCount: sortedDuplicateGroups.length,
    similarGroupCount: sortedSimilarGroups.length,
    uniqueImageCount: uniqueImages.length,
    duplicateGroups: sortedDuplicateGroups,
    similarGroups: sortedSimilarGroups,
    uniqueImages: uniqueImages,
  });
});

app.use(express.json());

app.post('/api/recycle', async (req: Request, res: Response) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).send({ error: 'filePath is required' });
  }

  try {
    const recycleDir = join(process.cwd(), 'Recycle');
    await fs.mkdir(recycleDir, { recursive: true });
    
    let destinationPath = join(recycleDir, basename(filePath));
    
    try {
      await fs.access(destinationPath);
      const randomSuffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      const name = basename(filePath, extname(filePath));
      const ext = extname(filePath);
      destinationPath = join(recycleDir, `${name}_${randomSuffix}${ext}`);
    } catch (accessError) {
    }
    
    const readStream = createReadStream(filePath);
    const writeStream = createWriteStream(destinationPath);
    
    await new Promise<void>((resolve, reject) => {
        readStream.pipe(writeStream);
        readStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', () => resolve());
    });
    
    await fs.unlink(filePath);
    
    const db = getDb();
    await db.run('DELETE FROM images WHERE file_path = ?', filePath);
    
    res.send({ success: true });
  } catch (error) {
    console.error('Error recycling file:', error);
    res.status(500).send({ error: (error as Error).message });
  }
});

app.get('/api/image/:id', async (req: Request, res: Response) => {
  const imageId = req.params.id;
  if (!imageId) {
    return res.status(400).send({ error: 'Image ID is required' });
  }

  try {
    const db = getDb();
    const imageRecord: any = await db.get('SELECT file_path FROM images WHERE id = ?', imageId);
    
    if (!imageRecord) {
      return res.status(404).send({ error: 'Image not found' });
    }
    
    const imagePath = imageRecord.file_path;
    res.sendFile(imagePath);
  } catch (error) {
    console.error('Error serving image:', error);
    res.status(500).send({ error: (error as Error).message });
  }
});

export function startServer() {
  app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
  });
}