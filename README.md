# PicPurge (图片清理)

## English Description
PicPurge is a powerful and versatile image management and organization tool developed with TypeScript. It helps you efficiently manage your vast photo collection by providing features such as image indexing, metadata extraction, duplicate detection, similarity analysis, and intelligent sorting. It also offers a web-based interface for easy viewing and management of your image library.

## 中文描述 (Chinese Description)
PicPurge (图片巢) 是一个功能强大且多用途的图像管理和整理工具，使用 TypeScript 开发。它通过提供图像索引、元数据提取、重复图片检测、相似图片分析和智能排序等功能，帮助您高效地管理庞大的照片集。此外，它还提供了一个基于Web的界面，方便您查看和管理图像库。

## Features (功能)

### English Features
*   **Comprehensive Image Indexing:** Automatically traverses specified paths, identifies various image formats (PNG, JPG, BMP, CR2, etc.), and indexes them into an SQLite3 database.
*   **Rich Metadata Extraction:** Extracts and stores image metadata (EXIF information) such as camera model, make, lens type, and content creation time.
*   **Duplicate and Similar Image Detection:** Calculates file MD5 hashes and image features (using hashing algorithms and Structural Similarity Index Measure - SSIM) to accurately identify duplicate and visually similar images.
*   **Intelligent Sorting:** Organizes images based on EXIF data (Camera Model Name, Make, Lens Type) and content creation time, with customizable naming conventions (`yyyyMMddHHmmss.sequence.format`).
*   **Asynchronous Processing:** Utilizes multi-threading/workers for efficient background processing of MD5 calculation and feature extraction, ensuring a smooth user experience.
*   **Recycle Bin Management:** Automatically moves small files (less than 10KB) to a designated 'Recycle' directory, acting as a soft-delete mechanism.
*   **Web-based Management Interface:** Provides a user-friendly web service to visualize duplicate and similar image analysis results, allowing for easy review, retention, or soft-deletion of files.

### 中文功能
*   **全面的图像索引：** 自动遍历指定路径，识别各种图像格式（PNG、JPG、BMP、CR2 等），并将其索引到 SQLite3 数据库中。
*   **丰富的元数据提取：** 提取并存储图像元数据（EXIF 信息），例如相机型号、制造商、镜头类型和内容创建时间。
*   **重复和相似图片检测：** 计算文件 MD5 哈希值和图像特征（使用哈希算法和结构相似性指数测量 - SSIM），以准确识别重复和视觉相似的图片。
*   **智能排序：** 根据 EXIF 数据（相机型号名称、制造商、镜头类型）和内容创建时间整理图像，并支持自定义命名约定（`yyyyMMddHHmmss.sequence.format`）。
*   **异步处理：** 利用多线程/Worker 进行高效的 MD5 计算和特征提取后台处理，确保流畅的用户体验。
*   **回收站管理：** 自动将小文件（小于 10KB）移动到指定的“Recycle”目录，作为软删除机制。
*   **基于Web的管理界面：** 提供用户友好的 Web 服务，可视化重复和相似图片分析结果，方便用户轻松查看、保留或软删除文件。

## Installation (安装)
```bash
# Clone the repository
git clone https://github.com/your-username/PicPurge.git
cd PicPurge

# Install dependencies
npm install

# Build the project (if applicable)
npm run build
```

## Usage (使用)
```bash
# Start the application
npm start

# Example: Process images in a directory
# npm start -- --path /path/to/your/images

# Example: Sort images in a directory
# npm start -- --path /path/to/your/images --sort
```
