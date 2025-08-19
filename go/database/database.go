package database

import (
	"database/sql"
	"fmt" // Import fmt for error formatting
	"log"
	"picpurge/processor"
	"time"

	_ "github.com/mattn/go-sqlite3" // Import the SQLite driver
)

var db *sql.DB

// ConnectDb initializes the database connection and creates the schema if it doesn't exist.
func ConnectDb() error {
	var err error
	db, err = sql.Open("sqlite3", ":memory:") // Use an in-memory database
	if err != nil {
		return fmt.Errorf("failed to open database: %w", err)
	}

	// Create the images table if it doesn't exist
	createTableSQL := `
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
		thumbnail_path TEXT,
		is_duplicate BOOLEAN DEFAULT FALSE,
		duplicate_of INTEGER,
		similar_images TEXT, -- JSON array of image IDs
		is_recycled BOOLEAN DEFAULT FALSE
	);
	`
	_, err = db.Exec(createTableSQL)
	if err != nil {
		return fmt.Errorf("failed to create images table: %w", err)
	}
	log.Println("ConnectDb: Images table created/ensured.")

	log.Println("ConnectDb: Database connected and schema ensured.")
	return nil
}

// GetDb returns the database connection.
func GetDb() *sql.DB {
	return db
}

// CloseDb closes the database connection.
func CloseDb() error {
	if db != nil {
		if err := db.Close(); err != nil {
			return fmt.Errorf("failed to close database: %w", err)
		}
	}
	return nil
}

// InsertImage inserts image metadata into the database.
func InsertImage(imageData *processor.ImageData) error {
	stmt, err := db.Prepare(`
		INSERT OR IGNORE INTO images (
			file_path, file_name, file_size, md5, image_width, image_height,
			device_make, device_model, lens_model, create_date, phash, thumbnail_path
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return fmt.Errorf("failed to prepare insert statement: %w", err)
	}
	defer stmt.Close()

	_, err = stmt.Exec(
		imageData.FilePath,
		imageData.FileName,
		imageData.FileSize,
		imageData.MD5,
		imageData.ImageWidth,
		imageData.ImageHeight,
		imageData.DeviceMake,
		imageData.DeviceModel,
		imageData.LensModel,
		imageData.CreateDate.Format(time.RFC3339), // Format time for DATETIME column
		imageData.PHash,
		imageData.ThumbnailPath,
	)
	if err != nil {
		return fmt.Errorf("failed to execute insert statement: %w", err)
	}
	return nil
}
