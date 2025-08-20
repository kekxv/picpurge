package database

import (
	"database/sql"
	"fmt"
	"io/ioutil"
	"log"
	"os"
	"picpurge/processor"
	"sync" // Import sync package
	"time"

	_ "github.com/mattn/go-sqlite3"
)

var (
	dbInstance *sql.DB
	once       sync.Once
	initErr    error  // To store any error from the once.Do block
	tempDBFile string // To store the temporary database file name for cleanup
)

// GetDBInstance returns the singleton database connection.
func GetDBInstance() (*sql.DB, error) {
	once.Do(func() {
		// This code will only be executed once
		// Create a temporary file for the database
		tempFile, err := ioutil.TempFile("", "picpurge_*.db")
		if err != nil {
			initErr = fmt.Errorf("failed to create temporary database file: %w", err)
			return
		}
		tempFileName := tempFile.Name()
		tempFile.Close() // Close the file so SQLite can use it

		// Store the temp file name for cleanup later
		tempDBFile = tempFileName

		dbInstance, initErr = sql.Open("sqlite3", tempFileName)
		if initErr != nil {
			initErr = fmt.Errorf("failed to open database: %w", initErr)
			return // Exit the once.Do function
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
		_, initErr = dbInstance.Exec(createTableSQL)
		if initErr != nil {
			initErr = fmt.Errorf("failed to create images table: %w", initErr)
			return // Exit the once.Do function
		}
		log.Println("ConnectDb: Images table created/ensured.")
		log.Println("ConnectDb: Database connected and schema ensured.")
	})

	if initErr != nil {
		return nil, initErr
	}
	return dbInstance, nil
}

// CloseDb closes the database connection and removes the temporary file.
func CloseDb() error {
	if dbInstance != nil {
		if err := dbInstance.Close(); err != nil {
			return fmt.Errorf("failed to close database: %w", err)
		}
		dbInstance = nil // Clear the instance after closing
	}

	// Remove the temporary database file if it exists
	if tempDBFile != "" {
		if err := os.Remove(tempDBFile); err != nil {
			log.Printf("Warning: failed to remove temporary database file %s: %v", tempDBFile, err)
		} else {
			log.Printf("Temporary database file %s removed successfully", tempDBFile)
		}
		tempDBFile = "" // Clear the file name
	}
	return nil
}

// InsertImage inserts image metadata into the database.
func InsertImage(imageData *processor.ImageData) error {
	db, err := GetDBInstance() // Get the singleton instance
	if err != nil {
		return err
	}

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
