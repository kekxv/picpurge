package util

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// CopyFile copies a file from src to dst.
func CopyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	destinationFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destinationFile.Close()

	_, err = io.Copy(destinationFile, sourceFile)
	return err
}

// RecycleFile moves a file to the Recycle directory.
func RecycleFile(filePath, recycleDir string) error {
	// Check if file exists
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return fmt.Errorf("file does not exist: %s", filePath)
	}

	// Create the Recycle directory if it doesn't exist
	if err := os.MkdirAll(recycleDir, 0755); err != nil {
		return fmt.Errorf("failed to create Recycle directory: %w", err)
	}

	// Get the base name of the file
	fileName := filepath.Base(filePath)

	// Generate the destination path
	destPath := filepath.Join(recycleDir, fileName)

	// If a file with the same name already exists in Recycle, add a counter
	counter := 1
	for {
		if _, err := os.Stat(destPath); os.IsNotExist(err) {
			break // File doesn't exist, we can use this path
		}
		// File exists, add a counter to the filename
		ext := filepath.Ext(fileName)
		nameWithoutExt := fileName[:len(fileName)-len(ext)]
		destPath = filepath.Join(recycleDir, fmt.Sprintf("%s_%d%s", nameWithoutExt, counter, ext))
		counter++

		// Prevent infinite loop
		if counter > 1000 {
			return fmt.Errorf("too many files with the same name in Recycle directory")
		}
	}

	// Move the file to the Recycle directory
	if err := os.Rename(filePath, destPath); err != nil {
		// If Rename fails, try to copy and then remove
		if copyErr := CopyFile(filePath, destPath); copyErr != nil {
			return fmt.Errorf("failed to move or copy file: %w", copyErr)
		}
		// Remove the original file
		if removeErr := os.Remove(filePath); removeErr != nil {
			return fmt.Errorf("copied file successfully but failed to remove original: %w", removeErr)
		}
	}

	return nil
}
