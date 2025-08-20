package processor

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestProcessImage(t *testing.T) {
	// Create a temporary directory
	tempDir := t.TempDir()

	// Create a simple PNG image
	img := image.NewRGBA(image.Rect(0, 0, 100, 100))
	// Fill with a solid color
	for y := 0; y < 100; y++ {
		for x := 0; x < 100; x++ {
			img.Set(x, y, color.RGBA{255, 0, 0, 255}) // Red
		}
	}

	// Save the image to a file
	imagePath := filepath.Join(tempDir, "test.png")
	file, err := os.Create(imagePath)
	if err != nil {
		t.Fatalf("Failed to create test image file: %v", err)
	}
	defer file.Close()

	err = png.Encode(file, img)
	if err != nil {
		t.Fatalf("Failed to encode PNG image: %v", err)
	}

	// Test ProcessImage function
	imageData, thumbnailData, err := ProcessImage(imagePath)
	if err != nil {
		t.Fatalf("ProcessImage failed: %v", err)
	}

	if imageData == nil {
		t.Fatal("ProcessImage returned nil imageData")
	}

	if imageData.FilePath != imagePath {
		t.Errorf("FilePath mismatch. Expected: %s, Got: %s", imagePath, imageData.FilePath)
	}

	if imageData.FileName != "test.png" {
		t.Errorf("FileName mismatch. Expected: test.png, Got: %s", imageData.FileName)
	}

	if imageData.ImageWidth != 100 {
		t.Errorf("ImageWidth mismatch. Expected: 100, Got: %d", imageData.ImageWidth)
	}

	if imageData.ImageHeight != 100 {
		t.Errorf("ImageHeight mismatch. Expected: 100, Got: %d", imageData.ImageHeight)
	}

	if thumbnailData == nil {
		t.Error("ThumbnailData is nil")
	}
}
