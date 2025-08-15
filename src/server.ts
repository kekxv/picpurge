
import express, { Request, Response } from 'express';
import { getDb } from './database.js';
import { promises as fs } from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import { join, basename, extname } from 'path'; // Added extname import

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use('/thumbnails', express.static(join(process.cwd(), 'thumbnails')));

app.get('/', async (req: Request, res: Response) => {
  const db = getDb();
  const allImages: any[] = await db.all('SELECT * FROM images');
  
  // Calculate total image count
  const totalImages = allImages.length;

  const duplicateGroups: { [key: string]: any[] } = {};
  allImages.forEach(img => {
    if (img.is_duplicate && img.duplicate_of !== null && img.duplicate_of !== undefined) {
      const masterImage = allImages.find(m => m.id === img.duplicate_of);
      if (masterImage) {
        const masterId = masterImage.id.toString(); // Ensure the key is a string
        if (!duplicateGroups[masterId]) {
          duplicateGroups[masterId] = [masterImage];
        }
        duplicateGroups[masterId].push(img);
      }
    }
  });

  const similarGroups: { [key: string]: any[] } = {};
  // First, collect all similar relationships
  const similarRelationships: { [id: number]: number[] } = {};
  
  allImages.forEach(img => {
    if (img.similar_images && img.similar_images !== 'null') {
      const similarIds = JSON.parse(img.similar_images);
      similarRelationships[img.id] = similarIds;
      
      // Add reverse relationships
      similarIds.forEach((similarId: number) => {
        if (!similarRelationships[similarId]) {
          similarRelationships[similarId] = [];
        }
        if (!similarRelationships[similarId].includes(img.id)) {
          similarRelationships[similarId].push(img.id);
        }
      });
    }
  });
  
  // Then, group images by their connections
  const visited = new Set<number>();
  Object.keys(similarRelationships).forEach(idStr => {
    const id = parseInt(idStr);
    if (visited.has(id)) return;
    
    // BFS to find all connected images
    const queue: number[] = [id];
    const group: number[] = [];
    
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      
      visited.add(currentId);
      group.push(currentId);
      
      const neighbors = similarRelationships[currentId] || [];
      neighbors.forEach(neighborId => {
        if (!visited.has(neighborId)) {
          queue.push(neighborId);
        }
      });
    }
    
    // Only create groups with more than one image
    if (group.length > 1) {
      // Create a unique key for the group based on sorted IDs
      const groupKey = group.sort((a, b) => a - b).join('-');
      similarGroups[groupKey] = group.map(groupId => 
        allImages.find(img => img.id === groupId)
      ).filter(img => img !== undefined) as any[];
    }
  });

  // Filter out unique images (not duplicates and not in any similar group)
  const uniqueImages = allImages.filter(img => {
    // Check if the image is not marked as a duplicate
    const isNotDuplicate = !img.is_duplicate;
    
    // Check if the image is not part of any similar group
    const isNotInAnySimilarGroup = !Object.keys(similarGroups).some(key => 
      key.split('-').map(Number).includes(img.id)
    );
    
    return isNotDuplicate && isNotInAnySimilarGroup;
  });

  // Calculate group counts
  const duplicateGroupCount = Object.keys(duplicateGroups).length;
  const similarGroupCount = Object.keys(similarGroups).length;
  const uniqueImageCount = uniqueImages.length;

  res.send(`
    <html>
      <head>
        <title>Image Util Results</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous">
        <style>
          .image-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
          }
          .image-item {
            border: 1px solid #ddd;
            padding: 5px;
            text-align: center;
            flex: 1 1 calc(10% - 10px); /* Adjust for 10 columns */
            min-width: 100px; /* Minimum width for smaller screens */
          }
          .image-item img {
            width: 100%;
            height: 100px; /* Fixed height for thumbnails */
            object-fit: contain; /* Change to contain to prevent distortion */
            cursor: pointer; /* Add cursor pointer for better UX */
          }
          .similar-group, .duplicate-group {
            border: 2px solid #007bff;
            padding: 15px;
            margin-bottom: 20px;
            border-radius: 8px;
          }
          .unique-images-section {
            margin-top: 40px;
            padding: 20px;
            border-top: 1px solid #eee;
          }
          .unique-images-section h2 {
            margin-bottom: 20px;
          }
          .unique-image-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
            justify-content: flex-start; /* Align items to the left */
          }
          .unique-image-item {
            flex: 0 0 calc(20% - 20px); /* 5 columns */
            min-width: 150px; /* Larger minimum width for unique images */
            border: 1px solid #ddd;
            border-radius: 5px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .unique-image-item img {
            width: 100%;
            height: 150px; /* Larger fixed height for unique image thumbnails */
            object-fit: contain; /* Change to contain to prevent distortion */
            cursor: pointer;
          }
          .unique-image-item .card-body {
            padding: 10px;
          }
          .unique-image-item .card-text {
            font-size: 0.9em;
            margin-bottom: 5px;
          }
          .unique-image-item .text-muted {
            font-size: 0.8em;
          }
          /* Modal styles for full-size image preview */
          .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            overflow: auto;
            background-color: rgb(0,0,0);
            background-color: rgba(0,0,0,0.9);
          }
          .modal-content {
            margin: auto;
            display: block;
            max-width: 90%;
            max-height: 90%;
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            object-fit: contain; /* Ensure the full image is visible without distortion */
          }
          .close {
            position: absolute;
            top: 15px;
            right: 35px;
            color: #f1f1f1;
            font-size: 40px;
            font-weight: bold;
            cursor: pointer;
          }
          .stats-card {
            background-color: #f8f9fa;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .stats-card h2 {
            margin-top: 0;
            color: #333;
          }
          .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 15px;
          }
          .stat-item {
            background-color: white;
            border-radius: 6px;
            padding: 15px;
            text-align: center;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          }
          .stat-item .count {
            font-size: 2rem;
            font-weight: bold;
            color: #007bff;
          }
          .stat-item .label {
            font-size: 0.9rem;
            color: #666;
          }
          @media (max-width: 768px) {
            .image-item {
              flex: 1 1 calc(33.333% - 10px); /* 3 columns on small screens */
            }
            .unique-image-item {
              flex: 0 0 calc(50% - 20px); /* 2 columns on small screens */
            }
            .stats-grid {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <!-- Statistics Section -->
          <div class="stats-card">
            <h2>Image Statistics</h2>
            <div class="stats-grid">
              <div class="stat-item">
                <div class="count">${totalImages}</div>
                <div class="label">Total Images</div>
              </div>
              <div class="stat-item">
                <div class="count">${duplicateGroupCount}</div>
                <div class="label">Duplicate Groups</div>
              </div>
              <div class="stat-item">
                <div class="count">${similarGroupCount}</div>
                <div class="label">Similar Groups</div>
              </div>
              <div class="stat-item">
                <div class="count">${uniqueImageCount}</div>
                <div class="label">Unique Images</div>
              </div>
            </div>
          </div>

          <h1 class="mt-4">Duplicate Image Groups</h1>
          ${Object.keys(duplicateGroups).map(groupKey => {
            const groupImages = duplicateGroups[groupKey];
            if (!groupImages) return '';
            return `
              <div class="duplicate-group" data-group-type="duplicate" data-group-id="${groupKey}">
                <h5>Group: ${groupKey} (${groupImages.length} images)</h5>
                <div class="image-grid">
                  ${groupImages.map((d: any) => {
                    const thumbnailSrc = d.thumbnail_path ? `/thumbnails/${basename(d.thumbnail_path)}` : '';
                    return `
                    <div class="image-item card">
                      ${thumbnailSrc ? '<img src="' + thumbnailSrc + '" class="card-img-top" alt="' + d.file_name + '" data-image-id="' + d.id + '" data-group-ids="' + groupKey + '">' : ''}
                      <div class="card-body">
                        <p class="card-text">' + d.file_name + '</p>
                        <p class="card-text text-muted">' + d.image_width + 'x' + d.image_height + ' ' + (d.is_duplicate ? 'Duplicate of ID: ' + d.duplicate_of : 'Original') + '</p>
                        <button class="btn btn-danger btn-sm" onclick="recycle(\'' + d.file_path.replace(/'/g, "\\'") + '\', this)">Recycle</button>
                      </div>
                    </div>
                  `;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('')}

          <h1 class="mt-4">Similar Image Groups</h1>
          ${Object.keys(similarGroups).map(groupKey => {
            const groupImages = similarGroups[groupKey];
            // Only display groups with more than one image
            if (!groupImages || groupImages.length < 2) return '';
            return `
              <div class="similar-group" data-group-type="similar" data-group-id="${groupKey}">
                <h5>Group: ${groupKey} (${groupImages.length} images)</h5>
                <div class="image-grid">
                  ${groupImages.map((s: any) => {
                    const thumbnailSrc = s.thumbnail_path ? `/thumbnails/${basename(s.thumbnail_path)}` : '';
                    return `
                    <div class="image-item card">
                      ${thumbnailSrc ? '<img src="' + thumbnailSrc + '" class="card-img-top" alt="' + s.file_name + '" data-image-id="' + s.id + '" data-group-ids="' + groupKey + '">' : ''}
                      <div class="card-body">
                        <p class="card-text">${s.file_name}</p>
                        <p class="card-text text-muted">` + s.image_width + 'x' + s.image_height + `</p>
                        <button class="btn btn-danger btn-sm" onclick="recycle(\'' + s.file_path.replace(/'/g, "\\'") + '\', this)">Recycle</button>
                      </div>
                    </div>
                  `;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('')}

          <!-- Unique Images Section -->
          <div class="unique-images-section">
            <h2>Unique Images (${uniqueImages.length} images)</h2>
            <div class="unique-image-grid">
              ${uniqueImages.map((u: any) => {
                const thumbnailSrc = u.thumbnail_path ? `/thumbnails/${basename(u.thumbnail_path)}` : '';
                return `
                  <div class=\"unique-image-item card\">\n                    ${thumbnailSrc ? '<img src=\"' + thumbnailSrc + '\" class=\"card-img-top\" alt=\"' + u.file_name + '\" data-image-id=\"' + u.id + '\">' : ''}\n                    <div class=\"card-body\">\n                      <p class=\"card-text\">` + u.file_name + `</p>\n                      <p class=\"card-text text-muted\">` + u.image_width + 'x' + u.image_height + `</p>\n                      <button class=\"btn btn-danger btn-sm\" onclick=\"recycle('' + u.file_path.replace(/'/g, \"'\") + '', this)\">Recycle</button>\n                    </div>\n                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>
        
        <!-- The Modal for image preview -->
        <div id="imagePreviewModal" class="modal">
          <span class="close">&times;</span>
          <img class="modal-content" id="previewImage">
          <div id="caption"></div>
          <div id="groupInfo" style="position: absolute; top: 60px; left: 20px; color: white; font-size: 16px;"></div>
          <button id="prevBtn" class="nav-btn" style="position: absolute; left: 20px; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.5); color: white; border: none; padding: 10px; cursor: pointer; display: none;">&lt; Prev</button>
          <button id="nextBtn" class="nav-btn" style="position: absolute; right: 20px; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.5); color: white; border: none; padding: 10px; cursor: pointer; display: none;">Next &gt;</button>
        </div>

        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz" crossorigin="anonymous"></script>
        <script>
          // Function to handle image preview modal
          function setupImagePreview() {
            const images = document.querySelectorAll('.image-item img, .unique-image-item img');
            const modal = document.getElementById("imagePreviewModal");
            const modalImg = document.getElementById("previewImage");
            const captionText = document.getElementById("caption");
            const span = document.getElementsByClassName("close")[0];
            const prevBtn = document.getElementById("prevBtn");
            const nextBtn = document.getElementById("nextBtn");
            const groupInfo = document.getElementById("groupInfo");
            
            // Current image tracking
            let currentImageId = null;
            let currentGroup = null;
            let currentGroupIndex = -1;
            
            // Find which group an image belongs to
            function findImageGroup(imageId) {
              const imageElement = document.querySelector('img[data-image-id="' + imageId + '"]');
              if (!imageElement) return null;
              
              const groupIds = imageElement.getAttribute('data-group-ids');
              if (!groupIds) return null;
              
              // Find the group container
              const groupContainer = imageElement.closest('[data-group-type]');
              if (!groupContainer) return null;
              
              const groupType = groupContainer.getAttribute('data-group-type');
              const groupId = groupContainer.getAttribute('data-group-id');
              
              // Get all images in this group
              const groupImages = Array.from(groupContainer.querySelectorAll('img'));
              const imageIds = groupImages.map(img => parseInt(img.getAttribute('data-image-id')));
              
              return { type: groupType, id: groupId, images: imageIds };
            }
            
            // Navigate to next/previous image in group
            function navigateGroup(direction) {
              if (!currentGroup || currentGroupIndex === -1) return;
              
              const groupImages = currentGroup.images;
              let newIndex = currentGroupIndex + direction;
              
              // Handle wraparound
              if (newIndex < 0) {
                newIndex = groupImages.length - 1;
              } else if (newIndex >= groupImages.length) {
                newIndex = 0;
              }
              
              currentGroupIndex = newIndex;
              const newImageId = groupImages[newIndex];
              currentImageId = newImageId;
              
              // Update image
              const timestamp = new Date().getTime();
              modalImg.src = '/api/image/' + newImageId + '?t=' + timestamp;
              
              // Update caption with group info
              const imageElement = document.querySelector('img[data-image-id="' + newImageId + '"]');
              if (imageElement) {
                captionText.innerHTML = imageElement.alt;
              }
              
              // Update group info
              groupInfo.innerHTML = 'Group: ' + currentGroup.id + ' (' + (newIndex + 1) + '/' + groupImages.length + ')';
            }
            
            images.forEach(img => {
              img.onclick = function(){
                const imageId = parseInt(this.getAttribute('data-image-id'));
                if (imageId) {
                  currentImageId = imageId;
                  
                  // Find which group this image belongs to
                  const group = findImageGroup(imageId);
                  currentGroup = group;
                  
                  if (group) {
                    currentGroupIndex = group.images.indexOf(imageId);
                    groupInfo.innerHTML = 'Group: ' + group.id + ' (' + (currentGroupIndex + 1) + '/' + group.images.length + ')';
                    // Show navigation buttons
                    prevBtn.style.display = 'block';
                    nextBtn.style.display = 'block';
                  } else {
                    currentGroupIndex = -1;
                    groupInfo.innerHTML = '';
                    // Hide navigation buttons for unique images
                    prevBtn.style.display = 'none';
                    nextBtn.style.display = 'none';
                  }
                  
                  const timestamp = new Date().getTime();
                  modal.style.display = "block";
                  modalImg.src = '/api/image/' + imageId + '?t=' + timestamp;
                  captionText.innerHTML = this.alt;
                } else {
                  console.error("Image ID not found for element:", this);
                }
              }
            });
            
            // Navigation button event handlers
            if (prevBtn) {
              prevBtn.onclick = function() {
                navigateGroup(-1);
              };
            }
            
            if (nextBtn) {
              nextBtn.onclick = function() {
                navigateGroup(1);
              };
            }
            
            // Keyboard navigation
            document.addEventListener('keydown', function(event) {
              if (modal.style.display === "block") {
                if (event.key === 'ArrowLeft') {
                  navigateGroup(-1);
                } else if (event.key === 'ArrowRight') {
                  navigateGroup(1);
                } else if (event.key === 'Escape') {
                  modal.style.display = "none";
                }
              }
            });
            
            if (span && modal) {
              span.onclick = function() {
                modal.style.display = "none";
              }
              
              // Also close the modal if the user clicks anywhere outside the image
              modal.onclick = function(event) {
                if (event.target === modal) {
                  modal.style.display = "none";
                }
              }
            } else {
              console.warn("Modal close button or modal element not found");
            }
          }
          
          // Call setup function after the page loads
          window.onload = setupImagePreview;
          
          async function recycle(filePath, buttonElement) {
            console.log('Recycling file:', filePath);
            
            // Disable the button to prevent double clicks
            buttonElement.disabled = true;
            buttonElement.textContent = 'Recycling...';
            
            try {
              const response = await fetch('/api/recycle', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ filePath }) 
              });
              const data = await response.json();
              if (data.success) {
                console.log('File recycled successfully.');
                // Reload the page to update statistics
                window.location.reload();
              } else {
                console.error('Failed to recycle file:', data.error);
                alert('Failed to recycle file: ' + data.error);
                // Re-enable the button on failure
                buttonElement.disabled = false;
                buttonElement.textContent = 'Recycle';
              }
            } catch (error) {
              console.error('Error recycling file:', error);
              alert('Error recycling file: ' + error.message);
              // Re-enable the button on error
              buttonElement.disabled = false;
              buttonElement.textContent = 'Recycle';
            }
          }
        </script>
      </body>
    </html>
  `);
});

app.use(express.json());

app.post('/api/recycle', async (req: Request, res: Response) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).send({ error: 'filePath is required' });
  }

  try {
    const recycleDir = join(process.cwd(), 'Recycle');
    await fs.mkdir(recycleDir, { recursive: true });
    
    // Use copy and then unlink to handle cross-device moves
    let destinationPath = join(recycleDir, basename(filePath));
    
    // Check if file already exists in recycle bin and append a random number if it does
    try {
      await fs.access(destinationPath);
      const randomSuffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      const name = basename(filePath, extname(filePath));
      const ext = extname(filePath);
      destinationPath = join(recycleDir, `${name}_${randomSuffix}${ext}`);
    } catch (accessError) {
      // File does not exist in recycle bin, which is fine. Continue with original destinationPath.
      // The accessError is expected if the file doesn't exist, so we ignore it.
    }
    
    const readStream = createReadStream(filePath);
    const writeStream = createWriteStream(destinationPath);
    
    await new Promise<void>((resolve, reject) => {
        readStream.pipe(writeStream);
        readStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', () => resolve());
    });
    
    await fs.unlink(filePath);
    
    const db = getDb();
    const deletedImage: any = await db.get('SELECT * FROM images WHERE file_path = ?', filePath);
    
    if (deletedImage) {
      // Delete the image record from the database
      await db.run('DELETE FROM images WHERE file_path = ?', filePath);
      
      // If the deleted image was a duplicate, update its master image
      if (deletedImage.is_duplicate && deletedImage.duplicate_of) {
        // Check if the master image still has other duplicates
        const remainingDuplicates = await db.all(
          'SELECT id FROM images WHERE duplicate_of = ? AND is_duplicate = TRUE', 
          deletedImage.duplicate_of
        );
        
        // If no more duplicates, mark the master as not duplicate
        if (remainingDuplicates.length === 0) {
          await db.run(
            'UPDATE images SET is_duplicate = FALSE, duplicate_of = NULL WHERE id = ?', 
            deletedImage.duplicate_of
          );
        }
      }
      
      // If the deleted image was part of a similar group, update the group
      if (deletedImage.similar_images) {
        // For simplicity, we're not updating the similar_images field of other images in the group
        // In a more complex implementation, we might want to remove the deleted image's ID from 
        // the similar_images field of other images in the group
      }
    }
    
    res.send({ success: true });
  } catch (error) {
    console.error('Error recycling file:', error);
    res.status(500).send({ error: (error as Error).message });
  }
});

// Add a new route to serve the full-size image by ID
app.get('/api/image/:id', async (req: Request, res: Response) => {
  const imageId = req.params.id;
  if (!imageId) {
    return res.status(400).send({ error: 'Image ID is required' });
  }

  try {
    const db = getDb();
    const imageRecord: any = await db.get('SELECT file_path FROM images WHERE id = ?', imageId);
    
    if (!imageRecord) {
      return res.status(404).send({ error: 'Image not found' });
    }
    
    // Stream the image file directly to the client
    const imagePath = imageRecord.file_path;
    res.sendFile(imagePath);
  } catch (error) {
    console.error('Error serving image:', error);
    res.status(500).send({ error: (error as Error).message });
  }
});

export function startServer() {
  app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
  });
}
