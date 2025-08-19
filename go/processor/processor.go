package processor

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"image"
	_ "image/jpeg" // Import for JPEG decoding
	_ "image/png"  // Import for PNG decoding
	"io"
	"log"
	"os"
	"strings"
	"time"

	"github.com/chai2010/webp"         // Import webp encoder
	"github.com/corona10/goimagehash"  // Import goimagehash
	"github.com/nfnt/resize"           // Import for image resizing
	"github.com/rwcarlsen/goexif/exif" // Import goexif
)

// ImageData represents the extracted metadata for an image.
type ImageData struct {
	FilePath      string
	FileName      string
	FileSize      int64
	MD5           string
	ImageWidth    int
	ImageHeight   int
	DeviceMake    string
	DeviceModel   string
	LensModel     string
	CreateDate    time.Time
	PHash         string
	ThumbnailPath string
}

// ProcessImage extracts metadata from a given image file and returns thumbnail data.
func ProcessImage(filePath string) (*ImageData, []byte, error) {
	// --- Calculate MD5 hash ---
	fileForMD5, err := os.Open(filePath)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to open file for MD5: %w", err)
	}
	defer fileForMD5.Close()

	hash := md5.New()
	if _, err := io.Copy(hash, fileForMD5); err != nil {
		return nil, nil, fmt.Errorf("failed to calculate MD5: %w", err)
	}
	md5Hash := hex.EncodeToString(hash.Sum(nil))

	// --- Decode image and extract EXIF data ---
	fileForImage, err := os.Open(filePath)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to open file for image processing: %w", err)
	}
	defer fileForImage.Close()

	// Decode image to get dimensions and for thumbnail generation
	img, _, err := image.Decode(fileForImage)
	if err != nil {
		return nil, nil, err
	}

	// Get file info for size and creation date (from file system)
	fileInfo, err := os.Stat(filePath)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to get file info: %w", err)
	}

	imageData := &ImageData{
		FilePath:    filePath,
		FileName:    fileInfo.Name(),
		FileSize:    fileInfo.Size(),
		MD5:         md5Hash,
		ImageWidth:  img.Bounds().Dx(),
		ImageHeight: img.Bounds().Dy(),
		CreateDate:  fileInfo.ModTime(), // Default to file modification time
	}

	// Reset fileForImage pointer to read EXIF data from the beginning
	_, err = fileForImage.Seek(0, io.SeekStart)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to seek file for EXIF: %w", err)
	}

	// Extract EXIF data
	x, err := exif.Decode(fileForImage)
	if err == nil {
		// Camera Make
		if makeTag, err := x.Get(exif.Make); err == nil {
			imageData.DeviceMake = makeTag.String()
		}
		// Camera Model
		if modelTag, err := x.Get(exif.Model); err == nil {
			imageData.DeviceModel = modelTag.String()
		}
		// Lens Model (often in LensModel or LensMake)
		if lensTag, err := x.Get(exif.LensModel); err == nil {
			imageData.LensModel = lensTag.String()
		} else if lensTag, err := x.Get(exif.LensMake); err == nil {
			imageData.LensModel = lensTag.String()
		}

		// DateTimeOriginal (creation date from EXIF)
		if dtTag, err := x.Get(exif.DateTimeOriginal); err == nil {
			dt := dtTag.String()
			dt = strings.TrimPrefix(dt, "\"")
			dt = strings.TrimSuffix(dt, "\"")
			parsedTime, parseErr := time.Parse("2006:01:02 15:04:05", dt)
			if parseErr == nil {
				imageData.CreateDate = parsedTime
			} else {
				log.Printf("Warning: Error parsing EXIF DateTimeOriginal '%s' for %s: %v\n", dt, filePath, parseErr)
			}
		}
	} else {
		// log.Printf("Warning: No EXIF data found or error decoding EXIF for %s: %v\n", filePath, err)
	}

	// --- Calculate pHash ---
	phash, err := goimagehash.PerceptionHash(img)
	if err != nil {
		log.Printf("Warning: Could not calculate pHash for %s: %v\n", filePath, err)
		imageData.PHash = "" // Set to empty string if pHash calculation fails
	} else {
		imageData.PHash = phash.ToString() // Convert hash to string
	}

	// --- Generate Thumbnail (WebP) ---
	// Resize the image to 320x320 (or smaller if original is smaller)
	thumbnail := resize.Thumbnail(320, 320, img, resize.Lanczos3)

	// Encode thumbnail to WebP
	var buf bytes.Buffer
	var thumbnailData []byte
	if err := webp.Encode(&buf, thumbnail, &webp.Options{Lossless: false, Quality: 80}); err != nil { // Encode to WebP
		log.Printf("Warning: Could not generate WebP thumbnail for %s: %v\n", filePath, err)
		thumbnailData = nil // Set to nil if encoding fails
	} else {
		thumbnailData = buf.Bytes()
		// Set ThumbnailPath to a reference, e.g., "memory://<MD5>"
		imageData.ThumbnailPath = fmt.Sprintf("memory://%s", imageData.MD5)
	}

	return imageData, thumbnailData, nil
}
