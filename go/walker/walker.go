package walker

import (
	"fmt" // Import fmt for error formatting
	"os"
	"path/filepath"
	"strings"
)

// imageExtensions defines the supported image file extensions.
var imageExtensions = map[string]bool{
	".png":  true,
	".jpg":  true,
	".jpeg": true,
	".bmp":  true,
	".gif":  true,
	".tiff": true,
	".webp": true,
	".cr2":  true,
}

// IsImageFile checks if a given file path has a supported image extension.
func IsImageFile(filePath string) bool {
	ext := strings.ToLower(filepath.Ext(filePath))
	return imageExtensions[ext]
}

// FindImageFiles recursively finds image files in the given path.
func FindImageFiles(rootPath string) ([]string, error) {
	var imageFiles []string

	err := filepath.Walk(rootPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return fmt.Errorf("error accessing path %s: %w", path, err)
		}
		if info.IsDir() {
			return nil // Skip directories, filepath.Walk will recurse
		}

		if IsImageFile(path) { // Use the exported function
			imageFiles = append(imageFiles, path)
		}
		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("error walking path %s: %w", rootPath, err)
	}
	return imageFiles, nil
}
