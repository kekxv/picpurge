import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

let db: Database;
let dbFilePath: string;

export async function connectDb(): Promise<void> {
  // Generate a unique temporary file path for the database
  dbFilePath = path.join(os.tmpdir(), `picpurge-${Date.now()}.sqlite`);
  console.log(`[INFO] Using temporary database file: ${dbFilePath}`);

  db = await open({
    filename: dbFilePath,
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_size INTEGER,
      md5 TEXT,
      image_width INTEGER,
      image_height INTEGER,
      device_make TEXT,
      device_model TEXT,
      lens_model TEXT,
      create_date DATETIME,
      phash TEXT,
      is_duplicate BOOLEAN DEFAULT FALSE,
      duplicate_of INTEGER,
      similar_images TEXT,
      thumbnail_path TEXT
    )
  `);

  // Register cleanup function on process exit
  process.on('exit', cleanupDbFile);
  process.on('SIGINT', cleanupDbFile);
  process.on('SIGTERM', cleanupDbFile);
  process.on('uncaughtException', cleanupDbFile);
}

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not connected. Call connectDb() first.');
  }
  return db;
}

async function cleanupDbFile() {
  if (dbFilePath) {
    try {
      await db.close(); // Close the database connection before deleting
      await fs.unlink(dbFilePath);
      console.log(`[INFO] Cleaned up temporary database file: ${dbFilePath}`);
    } catch (err) {
      console.error(`[ERROR] Failed to clean up temporary database file ${dbFilePath}:`, err);
    }
  }
}