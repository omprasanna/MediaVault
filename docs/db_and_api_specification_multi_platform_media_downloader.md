# Database Schema & API Requirement Specification

**Project:** Self-Hosted Multi-Platform Media Downloader  
**Database Stack:** MongoDB 7.0 (Object Store) + Redis 7.0 (Queue & Caching Broker)  
**API Specification:** RESTful JSON API + HTTP Byte Streaming  
**Author / Architecture:** Senior Systems & Web Architect  

---

## 1. Database Specifications (MongoDB & Redis)

### 1.1 MongoDB Entity-Relationship Overview

The database uses MongoDB for document persistence, leveraging native B-Tree indexes for fast queries and TTL (Time-To-Live) indexes for automated ephemeral storage cleanup.

```
       +-------------------+               +-------------------+
       |       Users       |               |      Cookies      |
       +-------------------+               +-------------------+
       | _id (ObjectId)    |               | _id (ObjectId)    |
       | email (String)    |               | platform (String) |
       | password (String) |               | content (String)  |
       | createdAt (Date)  |               | updatedAt (Date)  |
       +-------------------+               +-------------------+
                 |
                 | 1 : N
                 v
       +-------------------+               +-------------------+
       |      Batches      | 1 : N         |       Jobs        |
       +-------------------+-------------> +-------------------+
       | _id (ObjectId)    |               | _id (ObjectId)    |
       | userId (ObjectId) |               | userId (ObjectId) |
       | totalItems (Num)  |               | batchId (String)  |
       | status (String)   |               | sourceUrl (String)|
       | createdAt (Date)  |               | status (String)   |
       +-------------------+               | progress (Number) |
                                           | expiresAt (Date)  |
                                           +-------------------+
```

---

### 1.2 Mongoose Schema Definitions

#### 1.2.1 `User` Schema (`users` collection)

Stores user account data for single-user/family self-hosted authentication.

```javascript
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    passwordHash: {
      type: String,
      required: true
    },
    role: {
      type: String,
      enum: ['admin', 'user'],
      default: 'admin'
    },
    lastLoginAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
```

#### 1.2.2 `Job` Schema (`jobs` collection)

Tracks execution status, resolution streams, format parameters, output path, and auto-cleanup lifecycle.

```javascript
const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    batchId: {
      type: String,
      default: null,
      index: true
    },
    sourceUrl: {
      type: String,
      required: true
    },
    platform: {
      type: String,
      match: /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/, // known slug (e.g. youtube) or derived registrable domain (e.g. tiktok.com)
      required: true,
      index: true
    },
    title: {
      type: String,
      default: 'Media File',
      trim: true
    },
    thumbnailUrl: {
      type: String,
      default: null
    },
    duration: {
      type: Number, // Duration in seconds
      default: 0
    },
    mode: {
      type: String,
      enum: ['video', 'audio'],
      required: true
    },
    container: {
      type: String,
      enum: ['mp4', 'mkv', 'webm', 'mp3'],
      required: true
    },
    formatSelector: {
      type: String,
      required: true // e.g. "137+140" or "bestvideo[height<=1080]+bestaudio"
    },
    useCookies: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      enum: ['queued', 'downloading', 'muxing', 'ready', 'failed', 'expired', 'cancelled'],
      default: 'queued',
      index: true
    },
    progress: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },
    downloadSpeed: {
      type: String, // e.g. "4.25MiB/s"
      default: null
    },
    eta: {
      type: String, // e.g. "00:24"
      default: null
    },
    filePath: {
      type: String,
      default: null
    },
    fileName: {
      type: String,
      default: null
    },
    fileSizeBytes: {
      type: Number,
      default: 0
    },
    errorMessage: {
      type: String,
      default: null
    },
    expiresAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

// Compound Index for fast user job history queries
jobSchema.index({ userId: 1, createdAt: -1 });

// Native MongoDB TTL Index: auto-purges expired job records
jobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Job', jobSchema);
```

#### 1.2.3 `Batch` Schema (`batches` collection)

Groups jobs spawned from multi-item playlist selections.

```javascript
const mongoose = require('mongoose');

const batchSchema = new mongoose.Schema(
  {
    batchId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    playlistTitle: {
      type: String,
      default: 'Playlist Download Batch'
    },
    playlistUrl: {
      type: String,
      required: true
    },
    totalItems: {
      type: Number,
      required: true
    },
    completedItems: {
      type: Number,
      default: 0
    },
    failedItems: {
      type: Number,
      default: 0
    },
    status: {
      type: String,
      enum: ['processing', 'completed', 'partial_failure', 'failed'],
      default: 'processing'
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Batch', batchSchema);
```

#### 1.2.4 `Cookie` Schema (`cookies` collection)

Stores uploaded Netscape format `cookies.txt` per target domain.

```javascript
const mongoose = require('mongoose');

const cookieSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      match: /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/, // any safe platform slug, e.g. youtube or tiktok.com
      required: true,
      unique: true,
      index: true
    },
    content: {
      type: String, // Raw Netscape formatted cookies content
      required: true
    },
    isValid: {
      type: Boolean,
      default: true
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Cookie', cookieSchema);
```

---

### 1.3 Redis Models & Queue Keys

Redis serves as the BullMQ task transport layer and live progress pub/sub channel.

| Key Structure | Type | TTL / Retention | Description |
| :--- | :--- | :--- | :--- |
| `bull:media-downloads:id` | Hash | Job completion | BullMQ task object containing download parameters. |
| `bull:media-downloads:waiting` | List | Volatile | Queue of pending download tasks awaiting execution. |
| `bull:media-downloads:active` | Set | Volatile | Currently processing download jobs (max concurrent = $2$). |
| `progress:job:<jobId>` | Hash | 1 Hour | Caches live progress percentage, download speed, and ETA for rapid UI polling. |

---

## 2. API Endpoints Specification

### 2.1 Authentication Endpoints

#### 2.1.1 Register User
* **Endpoint:** `POST /api/auth/register`
* **Access Control:** Public (Blocked if `ALLOW_REGISTRATION=false` in environment)
* **Request Body:**
  ```json
  {
    "email": "user@example.com",
    "password": "SecurePassword123!"
  }
  ```
* **Success Response (`201 Created`):**
  ```json
  {
    "success": true,
    "message": "User registered successfully.",
    "user": {
      "id": "65b2d8e9f1a23c0012a45bc8",
      "email": "user@example.com",
      "role": "admin"
    }
  }
  ```
* **Error Responses:**
  * `403 Forbidden`: `{"error": "Registration is currently disabled on this server."}`
  * `400 Bad Request`: Validation failure (email format, password length $< 8$).

#### 2.1.2 Login User
* **Endpoint:** `POST /api/auth/login`
* **Access Control:** Public
* **Request Body:**
  ```json
  {
    "email": "user@example.com",
    "password": "SecurePassword123!"
  }
  ```
* **Headers Returned:** Sets HTTP-only, SameSite Cookie `jwt=<token>; HttpOnly; Secure; Path=/`
* **Success Response (`200 OK`):**
  ```json
  {
    "success": true,
    "user": {
      "id": "65b2d8e9f1a23c0012a45bc8",
      "email": "user@example.com",
      "role": "admin"
    }
  }
  ```

#### 2.1.3 Authenticated User Status
* **Endpoint:** `GET /api/auth/me`
* **Access Control:** Authenticated (JWT)
* **Success Response (`200 OK`):** Returns current user details.

#### 2.1.4 Logout
* **Endpoint:** `POST /api/auth/logout`
* **Access Control:** Authenticated (JWT)
* **Behavior:** Clears `jwt` cookie.

---

### 2.2 Inspection & Format Parsing Endpoints

#### 2.2.1 Inspect Media URL
* **Endpoint:** `POST /api/inspect`
* **Access Control:** Authenticated
* **Request Body:**
  ```json
  {
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "useCookies": false
  }
  ```
* **Success Response — Single Video (`200 OK`):**
  ```json
  {
    "isPlaylist": false,
    "title": "Rick Astley - Never Gonna Give You Up (Official Music Video)",
    "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    "duration": 213,
    "platform": "youtube",
    "formats": [
      {
        "formatId": "direct-720p",
        "label": "720p MP4 (Direct Stream)",
        "container": "mp4",
        "mode": "video",
        "isDirect": true,
        "directUrl": "https://rr3---sn-n4v7sn7s.googlevideo.com/videoplayback?..."
      },
      {
        "formatId": "137+140",
        "label": "1080p HD (MP4 Stream-Copy Mux)",
        "container": "mp4",
        "mode": "video",
        "isDirect": false,
        "vcodec": "h264",
        "acodec": "aac"
      },
      {
        "formatId": "248+251",
        "label": "1080p HD (WebM VP9)",
        "container": "webm",
        "mode": "video",
        "isDirect": false,
        "vcodec": "vp9",
        "acodec": "opus"
      },
      {
        "formatId": "bestaudio",
        "label": "MP3 Audio (High Quality 320kbps)",
        "container": "mp3",
        "mode": "audio",
        "isDirect": false
      }
    ]
  }
  ```

* **Success Response — Playlist URL (`200 OK`):**
  ```json
  {
    "isPlaylist": true,
    "playlistTitle": "Favorite Synthpop Hits",
    "playlistUrl": "https://www.youtube.com/playlist?list=PL12345678",
    "totalItems": 3,
    "items": [
      {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "title": "Rick Astley - Never Gonna Give You Up",
        "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        "duration": 213
      },
      {
        "url": "https://www.youtube.com/watch?v=yPYZpwSpKmA",
        "title": "a-ha - Take On Me",
        "thumbnail": "https://i.ytimg.com/vi/yPYZpwSpKmA/hqdefault.jpg",
        "duration": 227
      }
    ]
  }
  ```

---

### 2.3 Job Management & Execution Endpoints

#### 2.3.1 Create Download Job(s)
* **Endpoint:** `POST /api/jobs`
* **Access Control:** Authenticated
* **Request Body (Single Video or Batch):**
  ```json
  {
    "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "useCookies": false,
    "items": [
      {
        "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "title": "Rick Astley - Never Gonna Give You Up",
        "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        "duration": 213,
        "formatSelector": "137+140",
        "container": "mp4",
        "mode": "video"
      }
    ]
  }
  ```
* **Success Response (`202 Accepted`):**
  ```json
  {
    "success": true,
    "batchId": null,
    "jobIds": ["65b2e104f1a23c0012a45be2"]
  }
  ```

#### 2.3.2 List User Job History
* **Endpoint:** `GET /api/jobs`
* **Access Control:** Authenticated
* **Query Parameters:** `?page=1&limit=20&status=ready`
* **Success Response (`200 OK`):**
  ```json
  {
    "jobs": [
      {
        "id": "65b2e104f1a23c0012a45be2",
        "title": "Rick Astley - Never Gonna Give You Up",
        "platform": "youtube",
        "container": "mp4",
        "mode": "video",
        "status": "ready",
        "progress": 100,
        "fileSizeBytes": 45219840,
        "expiresAt": "2026-11-23T21:00:00.000Z",
        "createdAt": "2026-11-23T20:30:00.000Z"
      }
    ],
    "pagination": {
      "total": 1,
      "page": 1,
      "pages": 1
    }
  }
  ```

#### 2.3.3 Poll Job Status (Real-time tracking)
* **Endpoint:** `GET /api/jobs/:id`
* **Access Control:** Authenticated
* **Success Response (`200 OK`):**
  ```json
  {
    "id": "65b2e104f1a23c0012a45be2",
    "status": "downloading",
    "progress": 68.4,
    "downloadSpeed": "5.12MiB/s",
    "eta": "00:08",
    "errorMessage": null
  }
  ```

#### 2.3.4 Download Processed File
* **Endpoint:** `GET /api/jobs/:id/file`
* **Access Control:** Authenticated
* **Behavior:** Streams the processed file from host directory `/tmp/downloads` with attachment headers.
* **Headers:** `Content-Disposition: attachment; filename="Rick_Astley_Never_Gonna_Give_You_Up.mp4"`

---

### 2.4 Fast-Path Byte Proxy Endpoint

#### 2.4.1 Direct Byte Proxy Stream
* **Endpoint:** `GET /api/proxy`
* **Access Control:** Authenticated
* **Query Parameters:**
  * `url`: Encoded target CDN media link
  * `filename`: Target output file name
  * `platform`: Platform slug (`instagram`, `x`, `facebook`, `tiktok.com`, ...)
* **Behavior:** Directly pipes external byte stream to client using chunked transfer encoding without writing to server disk.

---

### 2.5 Cookie Management Endpoints

#### 2.5.1 Get Platform Cookie Status
* **Endpoint:** `GET /api/cookies`
* **Access Control:** Authenticated
* **Success Response (`200 OK`):**
  ```json
  {
    "cookies": [
      { "platform": "youtube", "installed": true, "updatedAt": "2026-11-20T10:15:00.000Z" },
      { "platform": "instagram", "installed": true, "updatedAt": "2026-11-18T14:22:00.000Z" },
      { "platform": "facebook", "installed": false, "updatedAt": null },
      { "platform": "x", "installed": false, "updatedAt": null },
      { "platform": "dailymotion", "installed": false, "updatedAt": null },
      { "platform": "tiktok.com", "installed": false, "updatedAt": null }
    ]
  }
  ```
* **Notes:** Any safe platform slug is accepted; known platforms keep short identifiers and unknown hosts use a derived registrable domain.

#### 2.5.2 Upload Netscape Cookies File
* **Endpoint:** `POST /api/cookies/:platform`
* **Access Control:** Authenticated
* **Request Body (`multipart/form-data` or raw text):**
  ```json
  {
    "cookieText": "# Netscape HTTP Cookie File\n.youtube.com TRUE / FALSE 1790000000 VISITOR_INFO1_LIVE..."
  }
  ```
* **Success Response (`200 OK`):**
  ```json
  {
    "success": true,
    "message": "Cookies for youtube successfully updated and validated."
  }
  ```

#### 2.5.3 Delete Cookie File
* **Endpoint:** `DELETE /api/cookies/:platform`
* **Access Control:** Authenticated
* **Success Response (`200 OK`):** Clears cookie record and unlinks local `./data/cookies/<platform>.txt`.

---

### 2.6 System Operations Endpoints

#### 2.6.1 System Health & Storage Status
* **Endpoint:** `GET /api/system/status`
* **Access Control:** Authenticated (Admin)
* **Success Response (`200 OK`):**
  ```json
  {
    "system": {
      "ytDlpVersion": "2026.11.23",
      "ffmpegInstalled": true,
      "supportedProvidersCount": 1375,
      "supportedExtractorsCount": 1752,
      "tempStorageBytes": 0,
      "tempDiskFreeBytes": 48291048448,
      "downloadTtlMinutes": 30,
      "workerConcurrency": 2,
      "allowRegistration": false,
      "activeJobsCount": 1,
      "queuedJobsCount": 0,
      "dbConnected": true
    }
  }
  ```

#### 2.6.2 List Supported Providers
* **Endpoint:** `GET /api/system/providers`
* **Access Control:** Authenticated
* **Query Parameters:**
  * `q` (optional): Case-insensitive substring filter on provider names.
* **Behavior:** Returns the provider catalog read from the installed `yt-dlp --list-extractors` output (cached per process). Extractor variants such as `youtube:tab` collapse to a single base provider.
* **Success Response (`200 OK`):**
  ```json
  {
    "totalExtractors": 1752,
    "uniqueProviders": 1375,
    "providers": ["youtube", "tiktok", "vimeo", "..."]
  }
  ```

#### 2.6.3 Trigger Manual Extractor Update
* **Endpoint:** `POST /api/system/update-ytdlp`
* **Access Control:** Authenticated (Admin)
* **Behavior:** Spawns `yt-dlp -U` inside backend container to update extractors dynamically.
* **Success Response (`200 OK`):**
  ```json
  {
    "success": true,
    "output": "yt-dlp is up to date (2026.11.18)"
  }
  ```

---

## 3. Standardized HTTP Status & Error Codes

All JSON API errors return a standard envelope structure:

```json
{
  "error": {
    "code": "INVALID_URL",
    "message": "The provided URL is not supported or invalid.",
    "details": null
  }
}
```

| HTTP Code | Error Code Identifier | Description |
| :--- | :--- | :--- |
| `400 Bad Request` | `INVALID_URL` | URL failed HTTP(S) format validation or SSRF safety checks (private/loopback/link-local host or embedded credentials). |
| `401 Unauthorized` | `UNAUTHORIZED` | JWT token missing, expired, or invalid. |
| `403 Forbidden` | `REGISTRATION_DISABLED` | Attempted registration when `ALLOW_REGISTRATION=false`. |
| `404 Not Found` | `JOB_NOT_FOUND` | Requested job ID does not exist or file has expired. |
| `422 Unprocessable` | `EXTRACTOR_ERROR` | `yt-dlp` returned non-zero code (e.g. video removed/private). |
| `500 Internal Server` | `MUXING_FAILED` | FFmpeg failed during stream-copy container assembly. |
| `507 Storage Error` | `DISK_FULL` | Free disk space on host is less than minimum $2\text{ GB}$ threshold. |
