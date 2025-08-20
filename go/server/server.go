package server

import (
	"bytes"
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"picpurge/database"
	"picpurge/util"
)

//go:embed web/*
var webFiles embed.FS

// thumbnailMemoryStore stores thumbnails in memory, keyed by MD5 hash.
var thumbnailMemoryStore = make(map[string][]byte)
var thumbnailMutex sync.RWMutex // Mutex to protect concurrent access to the maps

// AddThumbnailToMemory adds a thumbnail to the in-memory store.
func AddThumbnailToMemory(md5 string, data []byte) {
	thumbnailMutex.Lock()
	defer thumbnailMutex.Unlock()
	thumbnailMemoryStore[md5] = data
}

// GetThumbnailFromMemory retrieves a thumbnail from the in-memory store.
func GetThumbnailFromMemory(md5 string) []byte {
	thumbnailMutex.RLock()
	defer thumbnailMutex.RUnlock()
	return thumbnailMemoryStore[md5]
}

// StartServer starts the HTTP server.
func StartServer(port int) error {
	// Serve static files from the embedded web directory
	http.HandleFunc("/", handleWebFiles)

	http.HandleFunc("/thumbnails/", handleThumbnails)
	// API Endpoints
	http.HandleFunc("/api/stats", handleStats)
	http.HandleFunc("/api/images", handleImages)
	http.HandleFunc("/api/recycle", handleRecycle)
	http.HandleFunc("/api/image/", handleImageFile)

	log.Printf("Server listening on :%d\n", port)
	err := http.ListenAndServe(fmt.Sprintf(":%d", port), nil)
	if err != nil {
		return fmt.Errorf("server failed to start: %w", err)
	}
	return nil
}

// handleWebFiles serves embedded web files
func handleWebFiles(w http.ResponseWriter, r *http.Request) {
	// Remove leading slash and default to index.html if empty
	path := r.URL.Path[1:]
	if path == "" {
		path = "index.html"
	}

	// Try to read the file from embedded FS
	fileData, err := fs.ReadFile(webFiles, "web/"+path)
	if err != nil {
		// If file not found, try index.html (for SPA routing)
		fileData, err = fs.ReadFile(webFiles, "web/index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		path = "index.html"
	}

	// Set content type based on file extension
	contentType := "text/html"
	switch {
	case strings.HasSuffix(path, ".css"):
		contentType = "text/css"
	case strings.HasSuffix(path, ".js"):
		contentType = "application/javascript"
	case strings.HasSuffix(path, ".png"):
		contentType = "image/png"
	case strings.HasSuffix(path, ".jpg"), strings.HasSuffix(path, ".jpeg"):
		contentType = "image/jpeg"
	case strings.HasSuffix(path, ".gif"):
		contentType = "image/gif"
	case strings.HasSuffix(path, ".svg"):
		contentType = "image/svg+xml"
	case strings.HasSuffix(path, ".ico"):
		contentType = "image/x-icon"
	case strings.HasSuffix(path, ".json"):
		contentType = "application/json"
	case strings.HasSuffix(path, ".webp"):
		contentType = "image/webp"
	}

	w.Header().Set("Content-Type", contentType)
	w.Write(fileData)
}

type StatsResponse struct {
	TotalImages         int `json:"totalImages"`
	DuplicateGroupCount int `json:"duplicateGroupCount"`
	SimilarGroupCount   int `json:"similarGroupCount"`
	UniqueImageCount    int `json:"uniqueImageCount"`
}

// handleStats returns image statistics.
func handleStats(w http.ResponseWriter, r *http.Request) {
	var db *sql.DB
	var err error

	db, err = database.GetDBInstance()
	if err != nil {
		http.Error(w, "Failed to connect to database", http.StatusInternalServerError)
		return
	}

	// Total Images
	var totalImages int
	err = db.QueryRow("SELECT COUNT(*) FROM images WHERE is_recycled = FALSE").Scan(&totalImages)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Duplicate Group Count
	var duplicateGroupCount int
	err = db.QueryRow("SELECT COUNT(DISTINCT md5) FROM images WHERE is_duplicate = TRUE AND is_recycled = FALSE").Scan(&duplicateGroupCount)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Similar Group Count (This is more complex and might need a dedicated function or more complex query)
	// For now, a placeholder or simplified count.
	var similarGroupCount int
	err = db.QueryRow("SELECT COUNT(*) FROM (SELECT 1 FROM images WHERE similar_images IS NOT NULL AND similar_images != '[]' AND is_recycled = FALSE GROUP BY similar_images) AS similar_groups").Scan(&similarGroupCount)
	if err != nil {
		log.Printf("Error querying similar group count: %v", err)
		// Fallback to a simpler query if the above fails
		err = db.QueryRow("SELECT COUNT(*) FROM images WHERE similar_images IS NOT NULL AND similar_images != '[]' AND is_recycled = FALSE").Scan(&similarGroupCount)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	// Unique Image Count (images that are neither duplicates nor similar to others)
	var uniqueImageCount int
	err = db.QueryRow(`
        SELECT COUNT(*) FROM images 
        WHERE is_duplicate = FALSE 
        AND (similar_images IS NULL OR similar_images = '[]') 
        AND is_recycled = FALSE
    `).Scan(&uniqueImageCount)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	response := StatsResponse{
		TotalImages:         totalImages,
		DuplicateGroupCount: duplicateGroupCount,
		SimilarGroupCount:   similarGroupCount,
		UniqueImageCount:    uniqueImageCount,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

type Image struct {
	ID            int    `json:"id"`
	FilePath      string `json:"file_path"`
	FileName      string `json:"file_name"`
	FileSize      int64  `json:"file_size"`
	MD5           string `json:"md5"`
	ImageWidth    int    `json:"image_width"`
	ImageHeight   int    `json:"image_height"`
	DeviceMake    string `json:"device_make"`
	DeviceModel   string `json:"device_model"`
	LensModel     string `json:"lens_model"`
	CreateDate    string `json:"create_date"`
	PHash         string `json:"phash"`
	ThumbnailPath string `json:"thumbnail_path"`
	IsDuplicate   bool   `json:"is_duplicate"`
	DuplicateOf   *int   `json:"duplicate_of"`
	SimilarImages string `json:"similar_images"`
	IsRecycled    bool   `json:"is_recycled"`
}

// Helper function to get all images from the database
func getAllImages(db *sql.DB) ([]Image, error) {
	rows, err := db.Query("SELECT id, file_path, file_name, file_size, md5, image_width, image_height, device_make, device_model, lens_model, create_date, phash, thumbnail_path, is_duplicate, duplicate_of, similar_images, is_recycled FROM images WHERE is_recycled = FALSE")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var images []Image
	for rows.Next() {
		var img Image
		var duplicateOf sql.NullInt64
		var similarImages sql.NullString
		var createDateStr string

		err := rows.Scan(
			&img.ID, &img.FilePath, &img.FileName, &img.FileSize, &img.MD5, &img.ImageWidth, &img.ImageHeight,
			&img.DeviceMake, &img.DeviceModel, &img.LensModel, &createDateStr, &img.PHash, &img.ThumbnailPath,
			&img.IsDuplicate, &duplicateOf, &similarImages, &img.IsRecycled,
		)
		if err != nil {
			log.Printf("Error scanning image row in getAllImages: %v\n", err)
			continue
		}

		img.CreateDate = createDateStr
		if duplicateOf.Valid {
			val := int(duplicateOf.Int64)
			img.DuplicateOf = &val
		}
		if similarImages.Valid {
			img.SimilarImages = similarImages.String
		}

		images = append(images, img)
	}

	if err = rows.Err(); err != nil {
		return nil, err
	}

	return images, nil
}

// Helper function to get an image by ID in a slice of images
func findImageByID(images []Image, id int) *Image {
	for i := range images {
		if images[i].ID == id {
			return &images[i]
		}
	}
	return nil
}

// Helper function to get a sort key for images (e.g., area)
func getSortKey(image Image) int {
	return image.ImageWidth * image.ImageHeight
}

// handleImages returns paginated image data based on type (duplicates, similar, unique)
func handleImages(w http.ResponseWriter, r *http.Request) {
	db, err := database.GetDBInstance()
	if err != nil {
		http.Error(w, "Failed to connect to database", http.StatusInternalServerError)
		return
	}

	// Parse query parameters
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	imageType := r.URL.Query().Get("type")

	if page <= 0 {
		page = 1
	}
	if limit <= 0 {
		limit = 50 // Default limit
	}

	// Calculate offset
	offset := (page - 1) * limit

	// Get all images (this might be memory-intensive for large datasets)
	allImages, err := getAllImages(db)
	if err != nil {
		http.Error(w, "Failed to fetch images", http.StatusInternalServerError)
		return
	}

	// Filter images based on type
	var filteredImages []Image
	switch imageType {
	case "duplicates":
		for _, img := range allImages {
			if img.IsDuplicate {
				filteredImages = append(filteredImages, img)
			}
		}
	case "similar":
		for _, img := range allImages {
			if img.SimilarImages != "" && img.SimilarImages != "[]" {
				filteredImages = append(filteredImages, img)
			}
		}
	case "unique":
		for _, img := range allImages {
			if !img.IsDuplicate && (img.SimilarImages == "" || img.SimilarImages == "[]") {
				filteredImages = append(filteredImages, img)
			}
		}
	default:
		// Default to all images if no type specified
		filteredImages = allImages
	}

	// Sort images: duplicates by MD5, similar by similar_images, unique by file size (descending)
	if imageType == "duplicates" {
		sort.Slice(filteredImages, func(i, j int) bool {
			if filteredImages[i].MD5 != filteredImages[j].MD5 {
				return filteredImages[i].MD5 < filteredImages[j].MD5
			}
			// If MD5s are equal, sort by image area (larger first)
			return getSortKey(filteredImages[i]) > getSortKey(filteredImages[j])
		})
	} else if imageType == "similar" {
		sort.Slice(filteredImages, func(i, j int) bool {
			if filteredImages[i].SimilarImages != filteredImages[j].SimilarImages {
				return filteredImages[i].SimilarImages < filteredImages[j].SimilarImages
			}
			// If similar_images are equal, sort by image area (larger first)
			return getSortKey(filteredImages[i]) > getSortKey(filteredImages[j])
		})
	} else {
		// For unique images or all images, sort by file size (descending)
		sort.Slice(filteredImages, func(i, j int) bool {
			return filteredImages[i].FileSize > filteredImages[j].FileSize
		})
	}

	// Calculate total count for pagination
	totalImages := len(filteredImages)

	// Apply pagination
	start := offset
	end := start + limit
	if start > totalImages {
		start = totalImages
	}
	if end > totalImages {
		end = totalImages
	}

	paginatedImages := filteredImages[start:end]

	// Prepare response data
	var response map[string]interface{}

	if imageType == "duplicates" {
		// Group duplicates by MD5
		duplicateGroups := make(map[string][]Image)
		for _, img := range paginatedImages {
			if img.IsDuplicate {
				duplicateGroups[img.MD5] = append(duplicateGroups[img.MD5], img)
			}
		}

		// Convert map to slice of slices
		var groups [][]Image
		for _, group := range duplicateGroups {
			// Sort each group by image area (larger first)
			sort.Slice(group, func(i, j int) bool {
				return getSortKey(group[i]) > getSortKey(group[j])
			})
			groups = append(groups, group)
		}

		response = map[string]interface{}{
			"duplicateGroups": groups,
			"totalImages":     totalImages,
		}
	} else if imageType == "similar" {
		// Group similar images by similar_images field
		similarGroups := make(map[string][]Image)
		for _, img := range paginatedImages {
			if img.SimilarImages != "" && img.SimilarImages != "[]" {
				similarGroups[img.SimilarImages] = append(similarGroups[img.SimilarImages], img)
			}
		}

		// Convert map to slice of slices
		var groups [][]Image
		for _, group := range similarGroups {
			// Sort each group by image area (larger first)
			sort.Slice(group, func(i, j int) bool {
				return getSortKey(group[i]) > getSortKey(group[j])
			})
			groups = append(groups, group)
		}

		response = map[string]interface{}{
			"similarGroups": groups,
			"totalImages":   totalImages,
		}
	} else {
		// For unique images or all images
		response = map[string]interface{}{
			"images":      paginatedImages,
			"totalImages": totalImages,
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// handleRecycle handles recycling (moving to trash) of an image file
func handleRecycle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var requestData struct {
		FilePath string `json:"filePath"`
	}

	if err := json.NewDecoder(r.Body).Decode(&requestData); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if requestData.FilePath == "" {
		http.Error(w, "File path is required", http.StatusBadRequest)
		return
	}

	// Use the utility function to recycle the file
	if err := util.RecycleFile(requestData.FilePath, "Recycle"); err != nil {
		http.Error(w, fmt.Sprintf("Failed to recycle file: %v", err), http.StatusInternalServerError)
		return
	}

	// Update the database to mark the image as recycled
	db, err := database.GetDBInstance()
	if err != nil {
		http.Error(w, "Failed to connect to database", http.StatusInternalServerError)
		return
	}

	_, err = db.Exec("UPDATE images SET is_recycled = TRUE WHERE file_path = ?", requestData.FilePath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to update database: %v", err), http.StatusInternalServerError)
		return
	}

	response := map[string]interface{}{
		"success": true,
		"message": "File recycled successfully",
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// handleImageFile serves the original image file
func handleImageFile(w http.ResponseWriter, r *http.Request) {
	imageIDStr := r.URL.Path[len("/api/image/"):]

	db, err := database.GetDBInstance()
	if err != nil {
		http.Error(w, "Failed to connect to database", http.StatusInternalServerError)
		return
	}

	var filePath, md5 string
	err = db.QueryRow("SELECT file_path, md5 FROM images WHERE id = ?", imageIDStr).Scan(&filePath, &md5)
	if err != nil {
		http.Error(w, "Image not found", http.StatusNotFound)
		return
	}

	// Check if it's a CR2 file that needs conversion
	ext := strings.ToLower(filepath.Ext(filePath))
	if ext == ".cr2" {
		// Generate a preview image on-demand
		previewData, err := generateCR2Preview(filePath)
		if err != nil {
			log.Printf("Error generating CR2 preview for %s: %v", filePath, err)
			http.Error(w, fmt.Sprintf("Error generating preview: %v", err), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "image/jpeg")
		w.Write(previewData)
		return
	}

	http.ServeFile(w, r, filePath)
}

// generateCR2Preview generates a preview image for CR2 files
func generateCR2Preview(filePath string) ([]byte, error) {
	// Check if dcraw is installed
	if _, err := exec.LookPath("dcraw"); err != nil {
		return nil, fmt.Errorf("dcraw is not installed. Please install dcraw to view CR2 files")
	}

	// Check if convert (ImageMagick) is installed
	if _, err := exec.LookPath("convert"); err != nil {
		return nil, fmt.Errorf("ImageMagick is not installed. Please install ImageMagick to view CR2 files")
	}

	// Use dcraw to convert CR2 to PPM with half size for better performance
	cmd := exec.Command("dcraw", "-c", "-q", "3", "-w", "-H", "5", "-h", filePath)
	var ppmData bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &ppmData
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("dcraw failed: %w, stderr: %s", err, stderr.String())
	}

	// Convert PPM to JPEG using ImageMagick's convert command
	convertCmd := exec.Command("convert", "-", "-quality", "85", "jpeg:-")
	convertCmd.Stdin = &ppmData

	var jpegData bytes.Buffer
	var convertStderr bytes.Buffer
	convertCmd.Stdout = &jpegData
	convertCmd.Stderr = &convertStderr

	if err := convertCmd.Run(); err != nil {
		return nil, fmt.Errorf("convert failed: %w, stderr: %s", err, convertStderr.String())
	}

	return jpegData.Bytes(), nil
}

// handleThumbnails serves image thumbnails from the in-memory store.
func handleThumbnails(w http.ResponseWriter, r *http.Request) {
	md5 := r.URL.Path[len("/thumbnails/"):]
	if md5 == "" {
		http.Error(w, "MD5 is required", http.StatusBadRequest)
		return
	}

	thumbnailData := GetThumbnailFromMemory(md5)
	if thumbnailData == nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", "image/webp") // Changed to image/webp
	w.Write(thumbnailData)
}
