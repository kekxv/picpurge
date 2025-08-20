package walker

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsImageFile(t *testing.T) {
	testCases := []struct {
		filePath string
		expected bool
	}{
		{"test.png", true},
		{"test.jpg", true},
		{"test.jpeg", true},
		{"test.gif", true},
		{"test.bmp", true},
		{"test.tiff", true},
		{"test.tif", true},
		{"test.webp", true},
		{"test.cr2", true},
		{"test.nef", true},
		{"test.arw", true},
		{"test.dng", true},
		{"test.orf", true},
		{"test.rw2", true},
		{"test.pef", true},
		{"test.sr2", true},
		{"test.raf", true},
		{"test.3fr", true},
		{"test.fff", true},
		{"test.mos", true},
		{"test.iiq", true},
		{"test.mef", true},
		{"test.mrw", true},
		{"test.x3f", true},
		{"test.txt", false},
		{"test.pdf", false},
		{"test.doc", false},
		{"test", false},
	}

	for _, tc := range testCases {
		result := IsImageFile(tc.filePath)
		if result != tc.expected {
			t.Errorf("IsImageFile(%s) = %v; expected %v", tc.filePath, result, tc.expected)
		}
	}
}

func TestFindImageFiles(t *testing.T) {
	// Create a temporary directory structure for testing
	tempDir := t.TempDir()

	// Create some image files
	imageFiles := []string{"a.png", "b.jpg", "c.gif"}
	for _, fileName := range imageFiles {
		filePath := filepath.Join(tempDir, fileName)
		err := os.WriteFile(filePath, []byte("test"), 0644)
		if err != nil {
			t.Fatalf("Failed to create test file %s: %v", filePath, err)
		}
	}

	// Create a subdirectory with more image files
	subDir := filepath.Join(tempDir, "subdir")
	err := os.Mkdir(subDir, 0755)
	if err != nil {
		t.Fatalf("Failed to create subdirectory: %v", err)
	}

	subImageFiles := []string{"d.tiff", "e.webp"}
	for _, fileName := range subImageFiles {
		filePath := filepath.Join(subDir, fileName)
		err := os.WriteFile(filePath, []byte("test"), 0644)
		if err != nil {
			t.Fatalf("Failed to create test file %s: %v", filePath, err)
		}
	}

	// Create a non-image file
	nonImageFile := filepath.Join(tempDir, "not_image.txt")
	err = os.WriteFile(nonImageFile, []byte("test"), 0644)
	if err != nil {
		t.Fatalf("Failed to create non-image file: %v", err)
	}

	// Test FindImageFiles function
	foundFiles, err := FindImageFiles(tempDir)
	if err != nil {
		t.Fatalf("FindImageFiles failed: %v", err)
	}

	// Check that we found the right number of files
	expectedCount := len(imageFiles) + len(subImageFiles)
	if len(foundFiles) != expectedCount {
		t.Errorf("FindImageFiles returned %d files; expected %d", len(foundFiles), expectedCount)
	}

	// Check that all found files are in the expected locations
	expectedFiles := make(map[string]bool)
	for _, fileName := range imageFiles {
		expectedFiles[filepath.Join(tempDir, fileName)] = true
	}
	for _, fileName := range subImageFiles {
		expectedFiles[filepath.Join(subDir, fileName)] = true
	}

	for _, foundFile := range foundFiles {
		if !expectedFiles[foundFile] {
			t.Errorf("FindImageFiles returned unexpected file: %s", foundFile)
		}
	}
}
