# PicPurge (图片清理)

![Version](https://img.shields.io/badge/version-0.0.6-blue.svg)
![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)

## 📸 Say Goodbye to Clutter, Embrace Order: PicPurge, Your Smart Image Butler! （📸 告别杂乱，拥抱有序：PicPurge，您的智能图片管家！）

PicPurge (Image Cleanup) is a lightweight yet powerful image management tool designed to help you easily organize, deduplicate, and manage your vast image collection. It revitalizes your image library through intelligent indexing, duplicate and similar image detection, and other features.

PicPurge (图片清理) 是一款轻量级但功能强大的图片管理工具，旨在帮助您轻松整理、去重并管理您庞大的图片收藏。它通过智能索引、重复及相似图片检测等功能，让您的图片库焕然一新。

---

## 🚀 Features (核心功能)

*   **Intelligent Image Indexing & Management:** Automatically scans specified paths, identifies and indexes various image types, builds an efficient database, and extracts EXIF metadata.
*   **智能图片索引与管理：** 自动扫描指定路径，识别并索引各类图片，构建高效数据库，并提取 EXIF 元数据。

*   **Duplicate and Similar Image Detection:** Accurately identifies completely duplicate images and intelligently finds visually similar images, helping you save storage space.
*   **重复与相似图片检测：** 精准识别完全重复的图片，并智能找出视觉上相似的图片，助您节省存储空间。

*   **Efficient Organization & Smart Sorting:** Automatically categorizes and sorts images based on metadata (e.g., capture time, camera model), supporting custom naming.
*   **高效整理与智能排序：** 根据图片元数据（如拍摄时间、相机型号）自动分类和排序，支持自定义命名。

*   **Web Management Interface:** Provides an intuitive web interface for easy viewing, comparison, and management of images, especially duplicate and similar ones.
*   **Web 管理界面：** 提供直观的网页界面，方便您查看、对比和管理图片，尤其是重复和相似图片。

*   **Secure Recycle Bin:** Automatically moves small files (less than 10KB) to a recycle bin, preventing accidental deletion.
*   **安全回收站：** 自动将小文件移至回收站，避免误删。

---

## 🚀 Getting Started (快速开始)

It is recommended to run PicPurge using `npx` for a quick experience without installation 推荐使用 `npx` 方式运行 PicPurge，无需安装即可体验：

```bash
npx picpurge [options] [path...]
```

*   `[path...]`: The directory or file path(s) you want to process, supporting multiple paths simultaneously.
*   `[path...]`: 您希望处理的图片目录或文件路径，支持同时指定多个路径。

### Parameters (参数说明)

*   `--sort [path]`:
    *   **Function:** Organizes images into a new directory structure based on metadata (e.g., capture time).
    *   **功能:** 根据图片元数据（如拍摄时间）将图片分类整理到新的目录结构中。
    *   **Optional `[path]` parameter:** If provided, images will be **copied** to this target path for sorting, keeping the original files; if omitted, images will be **moved/renamed** in their original location.
    *   **可选参数 `[path]`:** 如果提供此路径，图片将被**复制**到该目标路径进行排序，原文件保留；如果省略，图片将在原位置被**移动/重命名**。
    *   **Example:**
        ```bash
        # Moves/renames images in the original path  在原路径移动/重命名图片
        npx picpurge --sort /path/to/your/images 
        # Copies and sorts to a new path 复制并排序到新路径
        npx picpurge --sort /new/sorted/images /path/to/your/images 
        ```

*   `-p, --port <port>`:
    *   **Function:** Specifies the port number for the PicPurge Web service.
    *   **功能:** 指定 PicPurge Web 服务启动的端口号。
    *   **Default Value:** `3000`.
    *   **默认值:** `3000`。
    *   **Example:**
        ```bash
        npx picpurge -p 8080 /path/to/your/images
        ```

*   `--recycle-path <path>`:
    *   **Function:** Specifies the path for the "Recycle" directory used to store small files (less than 10KB).
    *   **功能:** 指定用于存放小于 10KB 小文件的“回收站”目录路径。
    *   **Default Value:** If not specified, it defaults to a `Recycle` folder in the current working directory, and you will be prompted for confirmation on first run.
    *   **默认值:** 如果不指定，将默认为当前运行命令的目录下的 `Recycle` 文件夹，并在首次运行时会提示您确认。
    *   **Example:**
        ```bash
        npx picpurge --recycle-path /Users/YourName/PicPurgeRecycle /path/to/your/images
        ```

*   `[paths...]` (Positional Arguments):
    *   **Function:** Specifies one or more image directories or single image files for PicPurge to scan and process.
    *   **功能:** 指定一个或多个需要 PicPurge 扫描和处理的图片目录或单个图片文件。
    *   **Example:**
    *   **示例:**
        ```bash
        # Scans a single directory 扫描单个目录
        npx picpurge /path/to/photos
        # Scans multiple directories 扫描多个目录
        npx picpurge /path/to/photos /path/to/downloads 
        # Scans a single image file 扫描单个图片文件
        npx picpurge /path/to/image.jpg 
        ```

**Full Example**
**完整示例:**

```bash
npx picpurge --sort /sorted/pics -p 8000 --recycle-path /my/recycle/bin /my/photos /my/downloads
```

---

## 📄 License (许可证)

PicPurge is open-sourced under the [Apache License 2.0](LICENSE).

PicPurge 采用 [Apache License 2.0](LICENSE) 开放源代码。

---

**Thank you for using PicPurge! We hope it becomes a great helper for your image management.**

**感谢您使用 PicPurge！希望它能成为您管理图片的好帮手。**