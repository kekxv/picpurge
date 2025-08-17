
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

let db: Database;

export async function connectDb(): Promise<void> {
  db = await open({
    filename: ':memory:',
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
}

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not connected. Call connectDb() first.');
  }
  return db;
}
