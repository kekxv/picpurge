package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"picpurge/database"
	"picpurge/util"
)

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
	return images, nil
}

// Helper function to get images from a slice of IDs
func getImagesFromIDs(allImages []Image, ids []int) []Image {
	var result []Image
	for _, id := range ids {
		for i := range allImages {
			if allImages[i].ID == id {
				result = append(result, allImages[i])
				break
			}
		}
	}
	return result
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

// thumbnailMemoryStore stores thumbnails in memory, keyed by MD5 hash.
var thumbnailMemoryStore = make(map[string][]byte)
var thumbnailMutex sync.RWMutex // Mutex to protect concurrent access to the map

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
	// Serve static files from the 'web' directory
	fs := http.FileServer(http.Dir("web"))
	http.Handle("/", fs)

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

type StatsResponse struct {
	TotalImages         int `json:"totalImages"`
	DuplicateGroupCount int `json:"duplicateGroupCount"`
	SimilarGroupCount   int `json:"similarGroupCount"`
	UniqueImageCount    int `json:"uniqueImageCount"`
}

// handleStats returns image statistics.
func handleStats(w http.ResponseWriter, r *http.Request) {
	db := database.GetDb()

	// Total Images
	var totalImages int
	err := db.QueryRow("SELECT COUNT(*) FROM images WHERE is_recycled = FALSE").Scan(&totalImages)
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
	err = db.QueryRow("SELECT COUNT(*) FROM images WHERE similar_images IS NOT NULL AND similar_images != 'null' AND is_recycled = FALSE").Scan(&similarGroupCount)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Unique Image Count
	var uniqueImageCount int
	err = db.QueryRow("SELECT COUNT(*) FROM images WHERE is_duplicate = FALSE AND (similar_images IS NULL OR similar_images = 'null') AND is_recycled = FALSE").Scan(&uniqueImageCount)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	stats := StatsResponse{
		TotalImages:         totalImages,
		DuplicateGroupCount: duplicateGroupCount,
		SimilarGroupCount:   similarGroupCount,
		UniqueImageCount:    uniqueImageCount,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

type Image struct {
	ID            int    `json:"id"`
	FilePath      string `json:"file_path"`
	FileName      string `json:"file_name"`
	FileSize      int64  `json:"size"`
	MD5           string `json:"md5"`
	ImageWidth    int    `json:"image_width"`
	ImageHeight   int    `json:"image_height"`
	DeviceMake    string `json:"deviceMake"`
	DeviceModel   string `json:"deviceModel"`
	LensModel     string `json:"lensModel"`
	CreateDate    string `json:"create_date"` // Use string for JSON output
	PHash         string `json:"phash"`
	ThumbnailPath string `json:"thumbnail_path"`
	IsDuplicate   bool   `json:"is_duplicate"`
	DuplicateOf   *int   `json:"duplicate_of"` // Use pointer for nullable int
	SimilarImages string `json:"similar_images"`
	IsRecycled    bool   `json:"is_recycled"`
}

type ImagesResponse struct {
	TotalImages     int       `json:"totalImages"`
	CurrentPage     int       `json:"currentPage"`
	Limit           int       `json:"limit"`
	Images          []Image   `json:"images,omitempty"`
	DuplicateGroups [][]Image `json:"duplicateGroups,omitempty"`
	SimilarGroups   [][]Image `json:"similarGroups,omitempty"`
}

// handleImages returns paginated image data.
func handleImages(w http.ResponseWriter, r *http.Request) {
	db := database.GetDb()

	pageStr := r.URL.Query().Get("page")
	limitStr := r.URL.Query().Get("limit")
	typeStr := r.URL.Query().Get("type")

	page, err := strconv.Atoi(pageStr)
	if err != nil || page < 1 {
		page = 1
	}

	limit, err := strconv.Atoi(limitStr)
	if err != nil || limit < 1 {
		limit = 50 // Default limit
	}

	offset := (page - 1) * limit

	w.Header().Set("Content-Type", "application/json")

	var query string
	var countQuery string
	var params []interface{}

	switch typeStr {
	case "duplicates":
		allImagesForDuplicates, err := getAllImages(db)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		duplicateGroups := make(map[string][]Image)
		for _, img := range allImagesForDuplicates {
			if img.IsDuplicate && img.DuplicateOf != nil && *img.DuplicateOf != 0 {
				masterImage := findImageByID(allImagesForDuplicates, *img.DuplicateOf)
				if masterImage != nil {
					masterID := strconv.Itoa(masterImage.ID)
					if _, ok := duplicateGroups[masterID]; !ok {
						duplicateGroups[masterID] = []Image{*masterImage}
					}
					duplicateGroups[masterID] = append(duplicateGroups[masterID], img)
				}
			}
		}

		sortedDuplicateGroupKeys := make([]string, 0, len(duplicateGroups))
		for k := range duplicateGroups {
			sortedDuplicateGroupKeys = append(sortedDuplicateGroupKeys, k)
		}
		sort.Slice(sortedDuplicateGroupKeys, func(i, j int) bool {
			groupA := duplicateGroups[sortedDuplicateGroupKeys[i]]
			groupB := duplicateGroups[sortedDuplicateGroupKeys[j]]
			if len(groupA) == 0 || len(groupB) == 0 {
				return false
			}
			masterA := groupA[0]
			masterB := groupB[0]
			return getSortKey(masterA) > getSortKey(masterB)
		})

		paginatedDuplicateGroups := make([][]Image, 0)
		startIndex := offset
		endIndex := offset + limit
		if startIndex >= len(sortedDuplicateGroupKeys) {
			startIndex = len(sortedDuplicateGroupKeys)
		}
		if endIndex > len(sortedDuplicateGroupKeys) {
			endIndex = len(sortedDuplicateGroupKeys)
		}

		for i := startIndex; i < endIndex; i++ {
			paginatedDuplicateGroups = append(paginatedDuplicateGroups, duplicateGroups[sortedDuplicateGroupKeys[i]])
		}

		json.NewEncoder(w).Encode(ImagesResponse{
			TotalImages:     len(sortedDuplicateGroupKeys),
			CurrentPage:     page,
			Limit:           limit,
			DuplicateGroups: paginatedDuplicateGroups,
		})
		return
	case "similar":
		allImagesForSimilar, err := getAllImages(db)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		similarGroups := make(map[string][]Image)
		similarRelationships := make(map[int][]int)

		for _, img := range allImagesForSimilar {
			if img.SimilarImages != "" && img.SimilarImages != "null" {
				var similarIDs []int
				err := json.Unmarshal([]byte(img.SimilarImages), &similarIDs)
				if err != nil {
					log.Printf("Error unmarshalling similar_images for image ID %d: %v\n", img.ID, err)
					continue
				}
				similarRelationships[img.ID] = similarIDs
				for _, similarID := range similarIDs {
					if _, ok := similarRelationships[similarID]; !ok {
						similarRelationships[similarID] = []int{}
					}
					similarRelationships[similarID] = append(similarRelationships[similarID], img.ID)
				}
			}
		}

		visited := make(map[int]bool)
		for _, img := range allImagesForSimilar {
			if visited[img.ID] {
				continue
			}

			queue := []int{img.ID}
			group := []int{}

			for len(queue) > 0 {
				currentID := queue[0]
				queue = queue[1:]

				if visited[currentID] {
					continue
				}
				visited[currentID] = true
				group = append(group, currentID)

				neighbors := similarRelationships[currentID]
				for _, neighborID := range neighbors {
					if !visited[neighborID] {
						queue = append(queue, neighborID)
					}
				}
			}

			if len(group) > 1 {
				sort.Ints(group)
				groupKey := make([]string, len(group))
				for i, id := range group {
					groupKey[i] = strconv.Itoa(id)
				}
				similarGroups[strings.Join(groupKey, "-")] = getImagesFromIDs(allImagesForSimilar, group)
			}
		}

		sortedSimilarGroupKeys := make([]string, 0, len(similarGroups))
		for k := range similarGroups {
			sortedSimilarGroupKeys = append(sortedSimilarGroupKeys, k)
		}
		sort.Slice(sortedSimilarGroupKeys, func(i, j int) bool {
			groupA := similarGroups[sortedSimilarGroupKeys[i]]
			groupB := similarGroups[sortedSimilarGroupKeys[j]]
			if len(groupA) == 0 || len(groupB) == 0 {
				return false
			}
			firstImageA := groupA[0]
			firstImageB := groupB[0]
			return getSortKey(firstImageA) > getSortKey(firstImageB)
		})

		paginatedSimilarGroups := make([][]Image, 0)
		startIndex := offset
		endIndex := offset + limit
		if startIndex >= len(sortedSimilarGroupKeys) {
			startIndex = len(sortedSimilarGroupKeys)
		}
		if endIndex > len(sortedSimilarGroupKeys) {
			endIndex = len(sortedSimilarGroupKeys)
		}

		for i := startIndex; i < endIndex; i++ {
			paginatedSimilarGroups = append(paginatedSimilarGroups, similarGroups[sortedSimilarGroupKeys[i]])
		}

		json.NewEncoder(w).Encode(ImagesResponse{
			TotalImages:   len(sortedSimilarGroupKeys),
			CurrentPage:   page,
			Limit:         limit,
			SimilarGroups: paginatedSimilarGroups,
		})
		return

	case "unique":
		query = "SELECT id, file_path, file_name, file_size, md5, image_width, image_height, device_make, device_model, lens_model, create_date, phash, thumbnail_path, is_duplicate, duplicate_of, similar_images, is_recycled FROM images WHERE is_duplicate = FALSE AND (similar_images IS NULL OR similar_images = 'null') AND is_recycled = FALSE ORDER BY create_date ASC LIMIT ? OFFSET ?"
		countQuery = "SELECT COUNT(*) FROM images WHERE is_duplicate = FALSE AND (similar_images IS NULL OR similar_images = 'null') AND is_recycled = FALSE"
		params = []interface{}{limit, offset}

	case "all":
		fallthrough
	default:
		query = "SELECT id, file_path, file_name, file_size, md5, image_width, image_height, device_make, device_model, lens_model, create_date, phash, thumbnail_path, is_duplicate, duplicate_of, similar_images, is_recycled FROM images WHERE is_recycled = FALSE ORDER BY create_date ASC LIMIT ? OFFSET ?"
		countQuery = "SELECT COUNT(*) FROM images WHERE is_recycled = FALSE"
		params = []interface{}{limit, offset}
	}

	var totalCount int
	err = db.QueryRow(countQuery).Scan(&totalCount)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	rows, err := db.Query(query, params...)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
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
			log.Printf("Error scanning image row: %v\n", err)
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

	json.NewEncoder(w).Encode(ImagesResponse{
		TotalImages: totalCount,
		CurrentPage: page,
		Limit:       limit,
		Images:      images,
	})

}

type RecycleRequest struct {
	FilePath string `json:"filePath"`
}

type RecycleResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

// handleRecycle handles recycling (moving) a file.
func handleRecycle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req RecycleRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.FilePath == "" {
		json.NewEncoder(w).Encode(RecycleResponse{Success: false, Error: "File path is required."})
		return
	}

	db := database.GetDb()
	const recycleBinDir = "Recycle" // This should ideally be configurable

	fileName := filepath.Base(req.FilePath)
	destPath := filepath.Join(recycleBinDir, fileName)

	if err := os.MkdirAll(recycleBinDir, 0755); err != nil {
		log.Printf("Error creating recycle directory %s: %v\n", recycleBinDir, err)
		json.NewEncoder(w).Encode(RecycleResponse{Success: false, Error: fmt.Sprintf("Error creating recycle directory: %v", err)})
		return
	}

	if err := os.Rename(req.FilePath, destPath); err != nil {
		// If rename fails (e.g., cross-device link), copy and then delete original
		if copyErr := util.CopyFile(req.FilePath, destPath); copyErr != nil {
			log.Printf("Error moving/copying file to recycle bin %s: %v\n", req.FilePath, copyErr)
			json.NewEncoder(w).Encode(RecycleResponse{Success: false, Error: fmt.Sprintf("Error moving file: %v", copyErr)})
			return
		}
		if removeErr := os.Remove(req.FilePath); removeErr != nil {
			log.Printf("Warning: Copied %s to %s, but failed to remove original: %v\n", req.FilePath, destPath, removeErr)
		}
	}

	_, err = db.Exec("UPDATE images SET is_recycled = TRUE WHERE file_path = ?", req.FilePath)
	if err != nil {
		log.Printf("Error updating database for recycled image %s: %v\n", req.FilePath, err)
		json.NewEncoder(w).Encode(RecycleResponse{Success: false, Error: fmt.Sprintf("Error updating database: %v", err)})
		return
	}

	json.NewEncoder(w).Encode(RecycleResponse{Success: true, Message: "File recycled successfully."})
}

// handleImageFile serves the full-resolution image file.
func handleImageFile(w http.ResponseWriter, r *http.Request) {
	imageIDStr := strings.TrimPrefix(r.URL.Path, "/api/image/")
	if imageIDStr == "" {
		http.Error(w, "Image ID is required", http.StatusBadRequest)
		return
	}

	db := database.GetDb()
	var filePath string
	err := db.QueryRow("SELECT file_path FROM images WHERE id = ?", imageIDStr).Scan(&filePath)
	if err != nil {
		http.Error(w, "Image not found", http.StatusNotFound)
		return
	}

	http.ServeFile(w, r, filePath)
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
