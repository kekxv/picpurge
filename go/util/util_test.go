package util

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCopyFile(t *testing.T) {
	// Create a temporary source file
	srcFile, err := os.CreateTemp("", "test_src_*.txt")
	if err != nil {
		t.Fatalf("Failed to create temporary source file: %v", err)
	}
	defer os.Remove(srcFile.Name())
	srcFile.Close()

	// Write some content to the source file
	content := "Hello, World!"
	err = os.WriteFile(srcFile.Name(), []byte(content), 0644)
	if err != nil {
		t.Fatalf("Failed to write to source file: %v", err)
	}

	// Create a destination file path
	dstFile := filepath.Join(os.TempDir(), "test_dst.txt")
	defer os.Remove(dstFile)

	// Test CopyFile function
	err = CopyFile(srcFile.Name(), dstFile)
	if err != nil {
		t.Fatalf("CopyFile failed: %v", err)
	}

	// Check if the destination file exists
	if _, err := os.Stat(dstFile); os.IsNotExist(err) {
		t.Fatalf("Destination file was not created")
	}

	// Check if the content is correct
	dstContent, err := os.ReadFile(dstFile)
	if err != nil {
		t.Fatalf("Failed to read destination file: %v", err)
	}

	if string(dstContent) != content {
		t.Fatalf("Content mismatch. Expected: %s, Got: %s", content, string(dstContent))
	}
}

func TestRecycleFile(t *testing.T) {
	// Create a temporary file to recycle
	tempFile, err := os.CreateTemp("", "test_recycle_*.txt")
	if err != nil {
		t.Fatalf("Failed to create temporary file: %v", err)
	}
	defer os.Remove(tempFile.Name())
	tempFile.Close()

	// Create a recycle directory
	recycleDir := filepath.Join(os.TempDir(), "test_recycle_dir")
	defer os.RemoveAll(recycleDir)

	// Test RecycleFile function
	err = RecycleFile(tempFile.Name(), recycleDir)
	if err != nil {
		t.Fatalf("RecycleFile failed: %v", err)
	}

	// Check if the file was moved to the recycle directory
	recycledFile := filepath.Join(recycleDir, filepath.Base(tempFile.Name()))
	if _, err := os.Stat(recycledFile); os.IsNotExist(err) {
		t.Fatalf("File was not moved to recycle directory")
	}

	// Check if the original file no longer exists
	if _, err := os.Stat(tempFile.Name()); !os.IsNotExist(err) {
		t.Fatalf("Original file still exists")
	}
}
