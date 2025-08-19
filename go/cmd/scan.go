package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"picpurge/database"
	"picpurge/processor"
	"picpurge/server"
	"picpurge/util"
	"picpurge/walker"

	"github.com/briandowns/spinner"
	"github.com/corona10/goimagehash"
	"github.com/schollz/progressbar/v3"
	"github.com/spf13/cobra"
)

var scanCmd = &cobra.Command{
	Use:   "scan [paths...]",
	Short: "Scan specified paths for image files and process them.",
	Long:  `This command scans the provided directories or files for images, extracts metadata, and stores it in the database.`,
	Args:  cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {

		log.Printf("Scanning paths: %v\n", args)

		s := spinner.New(spinner.CharSets[14], 100*time.Millisecond)
		s.Prefix = "Scanning for image files "
		s.Start()

		var allImageFiles []string
		for _, path := range args {
			info, err := os.Stat(path)
			if err != nil {
				log.Printf("Error accessing path '%s': %v\n", path, err)
				continue
			}

			if info.IsDir() {
				files, err := walker.FindImageFiles(path)
				if err != nil {
					log.Printf("Error scanning directory '%s': %v\n", path, err)
					continue
				}
				allImageFiles = append(allImageFiles, files...)
			} else if info.Mode().IsRegular() {
				if walker.IsImageFile(path) {
					allImageFiles = append(allImageFiles, path)
				} else {
					log.Printf("Skipping non-image file: %s\n", path)
				}
			}
		}

		s.Stop()
		log.Printf("Found %d image files.\n", len(allImageFiles))

		if len(allImageFiles) == 0 {
			log.Println("No images to process.")
			return nil // No error, just no images
		}

		log.Println("Starting image processing...")

		bar := progressbar.Default(int64(len(allImageFiles)), "Processing images")

		numWorkers := runtime.NumCPU()
		if numWorkers == 0 {
			numWorkers = 1
		}
		log.Printf("Using %d worker goroutines for image processing.\n", numWorkers)

		jobs := make(chan string, len(allImageFiles))
		results := make(chan struct {
			ImageData     *processor.ImageData
			ThumbnailData []byte
		}, len(allImageFiles))
		errors := make(chan error, len(allImageFiles))
		var wg sync.WaitGroup

		for w := 0; w < numWorkers; w++ {
			wg.Add(1)
			go func(workerID int) {
				defer wg.Done()
				for filePath := range jobs {
					imageData, thumbnailData, err := processor.ProcessImage(filePath)
					if err != nil {
						//errors <- fmt.Errorf("error processing image '%s': %w", filePath, err)
						bar.Add(1)
						continue
					}
					results <- struct {
						ImageData     *processor.ImageData
						ThumbnailData []byte
					}{
						ImageData:     imageData,
						ThumbnailData: thumbnailData,
					}
					bar.Add(1)
				}
			}(w)
		}

		for _, filePath := range allImageFiles {
			jobs <- filePath
		}
		close(jobs)

		go func() {
			wg.Wait()
			close(results)
			close(errors)
		}()

		processedCount := 0
		errorCount := 0
		for {
			select {
			case res, ok := <-results:
				if !ok {
					results = nil
					break
				}
				if res.ThumbnailData != nil {
					server.AddThumbnailToMemory(res.ImageData.MD5, res.ThumbnailData)
				}

				err := database.InsertImage(res.ImageData)
				if err != nil {
					log.Printf("Error inserting image data for '%s': %v\n", res.ImageData.FilePath, err)
					errorCount++
					continue
				}
				processedCount++
			case errVal, ok := <-errors:
				if !ok {
					errors = nil
					break
				}
				log.Println(errVal)
				errorCount++
			}

			if results == nil && errors == nil {
				break
			}
		}

		log.Printf("Image processing complete. Successfully processed %d files, encountered %d errors.\n", processedCount, errorCount)

		// Handle recycle path
		if recyclePath == "" {
			defaultRecyclePath := "Recycle"
			log.Printf("Recycle directory not specified. Defaulting to: %s\n", defaultRecyclePath)
			fmt.Print("Continue with this path? (y/N): ")
			reader := bufio.NewReader(os.Stdin)
			input, _ := reader.ReadString('\n')
			input = strings.ToLower(strings.TrimSpace(input))
			if input != "y" {
				log.Println("Exiting.")
				return nil
			}
			recyclePath = defaultRecyclePath
		}
		log.Printf("Using Recycle directory: %s\n", recyclePath)

		// Find duplicates
		log.Println("Finding duplicates...")
		if err := runFindDuplicates(autoRecycleDuplicates, recyclePath); err != nil {
			return fmt.Errorf("error finding duplicates: %w", err)
		}
		log.Println("Duplicate analysis complete.")

		// Find similar images
		log.Println("Finding similar images...")
		if err := runFindSimilarImages(); err != nil {
			return fmt.Errorf("error finding similar images: %w", err)
		}
		log.Println("Similarity analysis complete.")

		// Sort images if flag is set
		if sortImagesFlag {
			log.Println("Sorting enabled. Starting image sorting...")
			// Use the first provided path as the root for sorting if no destination path is given
			sortRootPath := args[0]
			if err := runSortImages(sortRootPath, sortDestinationPath); err != nil {
				return fmt.Errorf("error sorting images: %w", err)
			}
			log.Println("Image sorting complete.")
		}

		// Start server
		log.Printf("Starting web server on port %d...\n", serverPort)
		if err := server.StartServer(serverPort); err != nil {
			return fmt.Errorf("failed to start server: %w", err)
		}

		// Keep the main goroutine alive if the server is running
		log.Printf("Server started on port %d. Press Ctrl+C to stop.\n", serverPort)
		select {}
		return nil
	},
}

var (
	autoRecycleDuplicates bool
	recyclePath           string
	sortImagesFlag        bool
	sortDestinationPath   string
	serverPort            int
)

func init() {
	RootCmd.AddCommand(scanCmd)
	scanCmd.Flags().BoolVar(&autoRecycleDuplicates, "auto-recycle-duplicates", false, "Automatically move all but one duplicate image to the recycle directory.")
	scanCmd.Flags().StringVar(&recyclePath, "recycle-path", "", "Specify the path for the Recycle directory.")
	scanCmd.Flags().BoolVar(&sortImagesFlag, "sort", false, "Sort images into directories based on metadata.")
	scanCmd.Flags().StringVar(&sortDestinationPath, "sort-destination", "", "Optionally provide a destination path to copy sorted images instead of moving them.")
	scanCmd.Flags().IntVarP(&serverPort, "port", "p", 3000, "Port to start the server on")
}

func runFindDuplicates(autoRecycleDuplicates bool, recyclePath string) error {
	log.Println("Finding duplicate images...")

	db := database.GetDb()

	rows, err := db.Query("SELECT md5 FROM images GROUP BY md5 HAVING COUNT(*) > 1")
	if err != nil {
		return fmt.Errorf("error querying for duplicate MD5s: %w", err)
	}
	defer rows.Close()

	var duplicateMD5s []string
	for rows.Next() {
		var md5 string
		if err := rows.Scan(&md5); err != nil {
			return fmt.Errorf("error scanning duplicate MD5: %w", err)
		}

		duplicateMD5s = append(duplicateMD5s, md5)
	}

	if len(duplicateMD5s) == 0 {
		log.Println("No duplicate MD5s found.")
		return nil
	}

	duplicatePairsCount := 0
	recycledCount := 0

	for _, md5 := range duplicateMD5s {
		imageRows, err := db.Query("SELECT id, file_path FROM images WHERE md5 = ? ORDER BY id ASC", md5)
		if err != nil {
			log.Printf("Error querying images for MD5 %s: %v\n", md5, err)
			continue
		}
		defer imageRows.Close()

		var imagesWithSameMd5 []struct {
			ID       int
			FilePath string
		}
		for imageRows.Next() {
			var img struct {
				ID       int
				FilePath string
			}
			if err := imageRows.Scan(&img.ID, &img.FilePath); err != nil {
				log.Printf("Error scanning image for MD5 %s: %v\n", md5, err)
				continue
			}
			imagesWithSameMd5 = append(imagesWithSameMd5, img)
		}

		if len(imagesWithSameMd5) > 1 {
			masterImageID := imagesWithSameMd5[0].ID
			for i := 1; i < len(imagesWithSameMd5); i++ {

				duplicateImage := imagesWithSameMd5[i]
				_, err := db.Exec("UPDATE images SET is_duplicate = ?, duplicate_of = ? WHERE id = ?", true, masterImageID, duplicateImage.ID)
				if err != nil {
					log.Printf("Error updating duplicate status for image ID %d: %v\n", duplicateImage.ID, err)
					continue
				}

				duplicatePairsCount++

				if autoRecycleDuplicates {
					fileName := filepath.Base(duplicateImage.FilePath)
					destPath := filepath.Join(recyclePath, fileName)

					if err := os.MkdirAll(recyclePath, 0755); err != nil {
						log.Printf("Error creating recycle directory %s: %v\n", recyclePath, err)
						continue
					}

					if err := os.Rename(duplicateImage.FilePath, destPath); err != nil {
						if copyErr := util.CopyFile(duplicateImage.FilePath, destPath); copyErr != nil {
							log.Printf("Error moving/copying file to recycle bin %s: %v\n", duplicateImage.FilePath, copyErr)
							continue
						}
						if removeErr := os.Remove(duplicateImage.FilePath); removeErr != nil {
							log.Printf("Warning: Copied %s to %s, but failed to remove original: %v\n", duplicateImage.FilePath, destPath, removeErr)
						}
					}

					_, err := db.Exec("UPDATE images SET is_recycled = TRUE WHERE file_path = ?", duplicateImage.FilePath)
					if err != nil {
						log.Printf("Error updating database for recycled image %s: %v\n", duplicateImage.FilePath, err)
						continue
					}
					recycledCount++
				}
			}
		}
	}

	log.Printf("Found and marked %d duplicate image pairs.\n", duplicatePairsCount)
	if autoRecycleDuplicates {
		log.Printf("Automatically recycled %d duplicate images.\n", recycledCount)
	}
	return nil
}

func runFindSimilarImages() error {
	log.Println("Finding similar images...")

	db := database.GetDb()

	// Fetch all images with pHash values
	rows, err := db.Query("SELECT id, phash, image_width, image_height FROM images WHERE phash IS NOT NULL AND phash != '' AND is_recycled = FALSE")
	if err != nil {
		return fmt.Errorf("error querying images for similar detection: %w", err)
	}
	defer rows.Close()

	type ImageForSimilar struct {
		ID          int
		PHash       *goimagehash.ImageHash
		ImageWidth  int
		ImageHeight int
	}

	var images []ImageForSimilar
	for rows.Next() {
		var id int
		var phashStr string
		var width, height int
		if err := rows.Scan(&id, &phashStr, &width, &height); err != nil {
			log.Printf("Error scanning image for similar detection: %v\n", err)
			continue
		}
		phash, err := goimagehash.ImageHashFromString(phashStr)
		if err != nil {
			log.Printf("Warning: Could not parse pHash string '%s' for image ID %d: %v\n", phashStr, id, err)
			continue
		}
		images = append(images, ImageForSimilar{ID: id, PHash: phash, ImageWidth: width, ImageHeight: height})
	}

	phashThreshold := 3         // Hamming distance threshold for pHash similarity
	sizeThreshold := 0.2        // 20% tolerance for size difference (ratio of areas)
	aspectRatioTolerance := 0.1 // 10% tolerance for aspect ratio

	similarPairsCount := 0

	for i := 0; i < len(images); i++ {
		image1 := images[i]
		if image1.PHash == nil {
			continue
		}
		similar := []int{}
		aspectRatio1 := float64(image1.ImageWidth) / float64(image1.ImageHeight)

		for j := i + 1; j < len(images); j++ {
			image2 := images[j]
			if image2.PHash == nil {
				continue
			}

			aspectRatio2 := float64(image2.ImageWidth) / float64(image2.ImageHeight)

			// Pre-filter: Check aspect ratio similarity first
			if aspectRatio1 == 0 || aspectRatio2 == 0 ||
				(aspectRatio1 > 0 && aspectRatio2 > 0 &&
					(math.Abs(aspectRatio1-aspectRatio2)/math.Max(aspectRatio1, aspectRatio2) > aspectRatioTolerance)) {
				continue // Aspect ratios are too different, skip pHash comparison
			}

			// Pre-filter: Check size similarity (ratio of areas)
			area1 := float64(image1.ImageWidth * image1.ImageHeight)
			area2 := float64(image2.ImageWidth * image2.ImageHeight)
			sizeRatio := math.Min(area1, area2) / math.Max(area1, area2)
			sizeDifference := 1 - sizeRatio

			if sizeDifference > sizeThreshold {
				continue // Sizes are too different, skip pHash comparison
			}

			// Calculate pHash distance only if pre-filters pass
			distance, err := image1.PHash.Distance(image2.PHash)
			if err != nil {
				log.Printf("Warning: Error calculating pHash distance between ID %d and ID %d: %v\n", image1.ID, image2.ID, err)
				continue
			}

			if distance <= phashThreshold {
				similar = append(similar, image2.ID)
				similarPairsCount++
			}
		}
		if len(similar) > 0 {
			// Update database: mark similar images
			similarJSON, err := json.Marshal(similar)
			if err != nil {
				log.Printf("Error marshalling similar images for ID %d: %v\n", image1.ID, err)
				continue
			}
			_, err = db.Exec("UPDATE images SET similar_images = ? WHERE id = ?", string(similarJSON), image1.ID)
			if err != nil {
				log.Printf("Error updating similar_images for image ID %d: %v\n", image1.ID, err)
			}
		}
	}

	log.Printf("Found and marked %d similar image pairs.\n", similarPairsCount)
	return nil
}

func runSortImages(rootPath string, destinationPath string) error {
	log.Printf("Sorting images from %s...\n", rootPath)
	if destinationPath != "" {
		log.Printf("Images will be copied to %s.\n", destinationPath)
	} else {
		log.Println("Images will be moved within the root path.")
	}

	db := database.GetDb()
	rows, err := db.Query("SELECT id, file_path, create_date FROM images WHERE is_duplicate = FALSE AND is_recycled = FALSE ORDER BY id ASC")
	if err != nil {
		return fmt.Errorf("error querying images for sorting: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var id int
		var filePath string
		var createDateStr string
		if err := rows.Scan(&id, &filePath, &createDateStr); err != nil {
			log.Printf("Error scanning image for sorting: %v\n", err)
			continue
		}

		createDate, err := time.Parse(time.RFC3339, createDateStr)
		if err != nil {
			log.Printf("Warning: Could not parse create_date '%s' for image ID %d. Using current time. Error: %v\n", createDateStr, id, err)
			createDate = time.Now()
		}

		year := createDate.Format("2006")
		month := createDate.Format("01")

		targetBaseDir := rootPath
		if destinationPath != "" {
			targetBaseDir = destinationPath
		}

		newBaseDir := filepath.Join(targetBaseDir, year, month)
		newFileName := fmt.Sprintf("%s.%s", filepath.Base(filePath), createDate.Format("20060102150405"))
		newPath := filepath.Join(newBaseDir, newFileName)

		if err := os.MkdirAll(newBaseDir, 0755); err != nil {
			log.Printf("Error creating directory %s: %v\n", newBaseDir, err)
			continue
		}

		if destinationPath != "" {
			if err := util.CopyFile(filePath, newPath); err != nil {
				log.Printf("Error copying file from %s to %s: %v\n", filePath, newPath, err)
				continue
			}
			log.Printf("Copied %s to %s\n", filepath.Base(filePath), newPath)
		} else {
			if err := os.Rename(filePath, newPath); err != nil {
				if copyErr := util.CopyFile(filePath, newPath); copyErr != nil {
					log.Printf("Error moving/copying file from %s to %s: %v\n", filePath, newPath, copyErr)
					continue
				}
				if removeErr := os.Remove(filePath); removeErr != nil {
					log.Printf("Warning: Copied %s to %s, but failed to remove original: %v\n", filePath, newPath, removeErr)
				}
				log.Printf("Moved %s to %s (via copy/delete)\n", filepath.Base(filePath), newPath)
			} else {
				log.Printf("Moved %s to %s\n", filepath.Base(filePath), newPath)
			}
			_, err := db.Exec("UPDATE images SET file_path = ? WHERE id = ?", newPath, id)
			if err != nil {
				log.Printf("Error updating file_path for image ID %d: %v\n", id, err)
			}
		}
	}
	log.Println("Image sorting complete.")
	return nil
}
