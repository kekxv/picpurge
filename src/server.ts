import express, { Request, Response } from 'express';
import { getDb } from './database.js';
import { promises as fs } from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import { join, basename, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

// In-memory storage for thumbnails (when size is under limit)
const thumbnailMemoryStore: Map<string, Buffer> = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Serve static files from src directory
app.use(express.static(__dirname));

// Serve thumbnails - handle both file-based and memory-based thumbnails
app.get('/thumbnails/:md5', async (req: Request, res: Response) => {
  const { md5 } = req.params;
  if(!md5){
      return res.status(404).send('Thumbnail file not found');
  }
  
  // Check if thumbnail is in memory
  if (thumbnailMemoryStore.has(md5||"")) {
    const thumbnailBuffer = thumbnailMemoryStore.get(md5||"")!;
    res.set('Content-Type', 'image/webp');
    return res.send(thumbnailBuffer);
  }
  
  // If not in memory, return 404
  return res.status(404).send('Thumbnail not found');
});

app.get('/', (req: Request, res: Response) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/api/stats', async (req: Request, res: Response) => {
  const db = getDb();
  const allImagesForStats: any[] = await db.all('SELECT * FROM images');
  const totalAllImages = allImagesForStats.length;

  const duplicateGroupsAll: { [key: string]: any[] } = {};
  allImagesForStats.forEach(img => {
    if (img.is_duplicate && img.duplicate_of !== null && img.is_duplicate !== undefined) {
      const masterImage = allImagesForStats.find(m => m.id === img.duplicate_of);
      if (masterImage) {
        const masterId = masterImage.id.toString();
        if (!duplicateGroupsAll[masterId]) {
          duplicateGroupsAll[masterId] = [masterImage];
        }
        duplicateGroupsAll[masterId].push(img);
      }
    }
  });
  const duplicateGroupCountAll = Object.keys(duplicateGroupsAll).length;

  const similarGroupsAll: { [key: string]: any[] } = {};
  const similarRelationshipsAll: { [id: number]: number[] } = {};
  allImagesForStats.forEach(img => {
    if (img.similar_images && img.similar_images !== 'null') {
      const similarIds = JSON.parse(img.similar_images);
      similarRelationshipsAll[img.id] = similarIds;
      similarIds.forEach((similarId: number) => {
        if (!similarRelationshipsAll[similarId]) {
          similarRelationshipsAll[similarId] = [];
        }
        if (!similarRelationshipsAll[similarId].includes(img.id)) {
          similarRelationshipsAll[similarId].push(img.id);
        }
      });
    }
  });
  const visitedAll = new Set<number>();
  Object.keys(similarRelationshipsAll).forEach(idStr => {
    const id = parseInt(idStr);
    if (visitedAll.has(id)) return;
    const queue: number[] = [id];
    const group: number[] = [];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visitedAll.has(currentId)) continue;
      visitedAll.add(currentId);
      group.push(currentId);
      const neighbors = similarRelationshipsAll[currentId] || [];
      neighbors.forEach(neighborId => {
        if (!visitedAll.has(neighborId)) {
          queue.push(neighborId);
        }
      });
    }
    if (group.length > 1) {
      const groupKey = group.sort((a, b) => a - b).join('-');
      similarGroupsAll[groupKey] = group.map(groupId => 
        allImagesForStats.find(img => img.id === groupId)
      ).filter(img => img !== undefined) as any[];
    }
  });
  const similarGroupCountAll = Object.keys(similarGroupsAll).length;

  const uniqueImagesAll = allImagesForStats.filter(img => {
    const isNotDuplicate = !img.is_duplicate;
    const isNotInAnySimilarGroup = !Object.values(similarGroupsAll).flat().some(s => s.id === img.id);
    return isNotDuplicate && isNotInAnySimilarGroup;
  });
  const uniqueImageCountAll = uniqueImagesAll.length;

  res.json({
    totalImages: totalAllImages,
    duplicateGroupCount: duplicateGroupCountAll,
    similarGroupCount: similarGroupCountAll,
    uniqueImageCount: uniqueImageCountAll,
  });
});

app.get('/api/images', async (req: Request, res: Response) => {
  const db = getDb();
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = (page - 1) * limit;
  const type = req.query.type as string || 'all'; // 'all', 'duplicates', 'similar', 'unique'

  let query = '';
  let countQuery = '';
  let params: any[] = [];
  let totalCount = 0;
  let images: any[] = [];

  // Helper functions (already present in the file, but I'll include them for context)
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

  function getSortKey(image: any): number {
    return (image.width || 0) * (image.height || 0);
  }

  switch (type) {
    case 'duplicates':
      const allImagesForDuplicates: any[] = await db.all('SELECT * FROM images');
      const duplicateGroups: { [key: string]: any[] } = {};
      allImagesForDuplicates.forEach(img => {
        if (img.is_duplicate && img.duplicate_of !== null && img.is_duplicate !== undefined) {
          const masterImage = allImagesForDuplicates.find(m => m.id === img.duplicate_of);
          if (masterImage) {
            const masterId = masterImage.id.toString();
            if (!duplicateGroups[masterId]) {
              duplicateGroups[masterId] = [masterImage];
            }
            duplicateGroups[masterId].push(img);
          }
        }
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
        if (keyA > keyB) return -1;
        if (keyA < keyB) return 1;
        return 0;
      });
      const paginatedDuplicateGroups = sortedDuplicateGroupKeys.slice(offset, offset + limit).map(key => duplicateGroups[key]);
      totalCount = sortedDuplicateGroupKeys.length;
      res.json({
        totalImages: totalCount,
        currentPage: page,
        limit: limit,
        duplicateGroups: paginatedDuplicateGroups,
      });
      return;

    case 'similar':
      const allImagesForSimilar: any[] = await db.all('SELECT * FROM images');
      const similarGroups: { [key: string]: any[] } = {};
      const similarRelationships: { [id: number]: number[] } = {};
      
      allImagesForSimilar.forEach(img => {
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
            allImagesForSimilar.find(img => img.id === groupId)
          ).filter(img => img !== undefined) as any[];
        }
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
        if (keyA > keyB) return -1;
        if (keyA < keyB) return 1;
        return 0;
      });
      const paginatedSimilarGroups = sortedSimilarGroupKeys.slice(offset, offset + limit).map(key => similarGroups[key]);
      totalCount = sortedSimilarGroupKeys.length;
      res.json({
        totalImages: totalCount,
        currentPage: page,
        limit: limit,
        similarGroups: paginatedSimilarGroups,
      });
      return;

    case 'unique':
      query = 'SELECT * FROM images WHERE is_duplicate = FALSE AND (similar_images IS NULL OR similar_images = \'null\') ORDER BY create_date ASC LIMIT ? OFFSET ?';
      countQuery = 'SELECT COUNT(*) as count FROM images WHERE is_duplicate = FALSE AND (similar_images IS NULL OR similar_images = \'null\')';
      params = [limit, offset];
      break;

    case 'all':
    default:
      query = 'SELECT * FROM images ORDER BY create_date ASC LIMIT ? OFFSET ?';
      countQuery = 'SELECT COUNT(*) as count FROM images';
      params = [limit, offset];
      break;
  }

  const totalImagesResult = await db.get(countQuery);
  totalCount = totalImagesResult ? totalImagesResult.count : 0;
  images = await db.all(query, ...params);

  res.json({
    totalImages: totalCount,
    currentPage: page,
    limit: limit,
    images: images, // Renamed from uniqueImages for 'all' and 'unique'
  });
});


import http from 'http'; // Import http module

export function addThumbnailToMemory(md5: string, buffer: Buffer) {
  thumbnailMemoryStore.set(md5, buffer);
}

export function removeThumbnailFromMemory(md5: string) {
  thumbnailMemoryStore.delete(md5);
}

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

export function startServer(): http.Server { // Change return type to http.Server
  const server = app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
  });
  return server; // Return the server instance
}