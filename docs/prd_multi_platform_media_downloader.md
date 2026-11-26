# Product Requirement Document (PRD) & Technical Specification

**Project Name:** Self-Hosted Multi-Platform Media Downloader  
**Target Environment:** Local Docker Setup (₹0 Self-Hosted) with optional Cloudflare Tunnel access  
**Tech Stack:** MERN (MongoDB, Express, React, Node.js) + Redis + BullMQ + `yt-dlp` + FFmpeg  
**Target Audience:** Single-user self-hosted utility / personal media archiver  

---

## 1. Executive Summary & Goals

### 1.1 Objective
Build a lightweight, zero-cost, self-hosted web application that enables downloading video and audio content from any site supported by the bundled `yt-dlp` build (over 1,700 extractors). YouTube (including YouTube Music), Facebook, Instagram, X (Twitter), and Dailymotion remain first-class platforms with tailored playlist handling and labels, while any other public URL accepted by `yt-dlp` is supported generically. The system provides real-time format selection (up to 1080p video resolution and MP3 audio extraction) and supports both individual URLs and selective multi-item playlist batch downloads.

### 1.2 Key Design Principles & Constraints
* **₹0 Cost Footprint:** Operates completely inside a local Docker Compose topology on home hardware/residential IP. Avoids paid cloud egress, third-party API keys, or cloud storage costs.
* **Fast Stream-Copy Muxing:** Avoids heavy video re-encoding. High-definition video (1080p) and audio streams are combined using FFmpeg stream copying (`-c copy`), executing in seconds with minimal CPU load.
* **Dual Download Execution Paths:**
  * **Fast Path (Direct Byte Proxy):** Streams pre-combined progressive media files directly from the platform CDN to the user's browser in real time without storing bytes on disk.
  * **Heavy Path (Asynchronous Worker):** Offloads multi-stream 1080p muxing, MP3 audio extraction, and multi-item playlists to a dedicated Redis + BullMQ queue with live progress polling.
* **Residential IP Advantage:** Leverages host residential networking via Docker to bypass common cloud IP blocks (e.g., YouTube HTTP 403 / bot detection errors on AWS/Render/Railway).

---

## 2. User Experience & Interface Flow

### 2.1 Web Interface Views
1. **Authentication Screen:**
   * JWT-based login form.
   * Registration flow (controllable via `ALLOW_REGISTRATION` environment variable; locked down after initial setup).
2. **Main Downloader Dashboard:**
   * **URL Input Field:** Accepts links for single videos, reels, tracks, or playlists.
   * **Inspect Button:** Triggers backend metadata extraction without queuing a download.
   * **Format / Quality Selector:** Displays clear options (e.g., MP4 1080p, WebM 1080p, MP4 720p Direct, MP3 Audio).
   * **Playlist Item Picker:** When a playlist URL is inspected, presents a list of videos with checkboxes, thumbnails, titles, and durations with "Select All" / "Deselect All" options.
   * **Active Queue & Download Drawer:** Shows real-time progress bars (`0–100%`) for queued/processing items with status tags (`Queued`, `Downloading`, `Muxing`, `Ready`, `Failed`).
3. **Download History Page:**
   * Lists recently processed files with individual download links, source metadata, and auto-expiry timers.
4. **Settings & Cookie Manager:**
   * Interface to upload, inspect, and delete Netscape-formatted `cookies.txt` files for any platform slug (`youtube.txt`, `instagram.txt`, `x.txt`, `tiktok.com.txt`, etc.).
   * Toggle switch for "Enable Authentication Cookies for Downloads".

### 2.2 Complete Downloader Flow Diagram

```
+-----------------------------------------------------------------------------------+
|                                   USER INTERFACE                                  |
+-----------------------------------------------------------------------------------+
       |                                                                     |
       | 1. Paste URL & Click Inspect                                       | 5. Direct Stream (720p/Reels)
       v                                                                     v
+-----------------------+                                         +------------------+
| GET /api/inspect      |                                         | GET /api/proxy   |
| (yt-dlp --dump-json)  |                                         | (Pipes CDN byte  |
+-----------------------+                                         |  stream directly |
       |                                                          |  to browser)     |
       | 2. Returns format list or playlist items                         +------------------+
       v                                                                     ^
+---------------------------------------------------+                        |
| USER SELECTION                                    |                        |
| - Single item or checked playlist items           |                        |
| - Target output format (MP4, MKV, WebM, MP3)     |                        |
+---------------------------------------------------+                        |
       |                                                                     |
       | 3. Submit Download Job(s)                                           |
       v                                                                     |
+---------------------------------------------------+                        |
| POST /api/jobs                                    |                        |
| Creates Job record(s) in MongoDB & pushes to Redis|                        |
+---------------------------------------------------+                        |
       |                                                                     |
       v                                                                     |
+-----------------------+    Polling Progress (2.5s)    +--------------------+
|  BullMQ Media Worker  | <===========================> |  React Client UI   |
|  - yt-dlp download    |                               |  - Updates status  |
|  - FFmpeg stream copy |                               |  - Renders download|
|  - Disk Write (/tmp)  |                               |    button on Ready |
+-----------------------+                               +--------------------+
       |                                                           |
       | 4. Job status set to 'ready'                              | 6. Click Download
       v                                                           v
+-----------------------------------------------------------------------------------+
| GET /api/jobs/:id/file (Serves local file from /tmp, auto-deletes on TTL expiry)  |
+-----------------------------------------------------------------------------------+
```

---

## 3. Supported Platforms & Quality Matrix

**Any public HTTP(S) URL supported by the bundled `yt-dlp` build is accepted** — the application no longer enforces a fixed hostname allowlist. The platform catalog is read at runtime from `yt-dlp --list-extractors` (currently 1,752 extractors across 1,375 providers) and exposed via `GET /api/system/providers`. Unknown hosts receive a derived platform slug (e.g. `www.tiktok.com` → `tiktok.com`) for labels and cookie files. URLs are still screened for SSRF safety (no private/loopback/link-local addresses, no embedded credentials) before any request is made.

The table below documents the first-class platforms with dedicated URL heuristics, labels, and playlist handling. Generic sites support single-item downloads with the same 1080p/stream-copy rules.

| Platform | URL Types | Maximum Resolution | Container / Codec | Muxing Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **YouTube** | Videos, Shorts, Live Recordings | 1080p | MP4 (H.264/AAC), WebM (VP9/Opus), MKV | Separate Video+Audio streams merged via FFmpeg `-c copy` |
| **YouTube Music** | Songs, Albums, Playlists | Audio-only | MP3 (320kbps extraction via `yt-dlp -x`) | Extracted via FFmpeg audio re-encode |
| **Instagram** | Posts, Reels, IGTV | Native max (typically 1080p) | MP4 | Direct Byte Proxy or Stream Copy |
| **Facebook** | Public & Private Videos, Reels | 1080p SD/HD | MP4 | Direct Byte Proxy or Stream Copy |
| **X (Twitter)** | Post Videos, Clips | Native max (720p/1080p) | MP4 | Direct Byte Proxy |
| **Dailymotion** | Channel Videos, Single Clips | 1080p | MP4, MKV | HLS stream download & stream-copy container mux |

---

## 4. System Architecture & Topology

### 4.1 Docker Container Topology

The entire application runs inside Docker Compose.

```
+----------------------------------------------------------------------------------------+
|                                    DOCKER NETWORK                                      |
|                                                                                        |
|  +-------------------+       +--------------------+       +-------------------------+  |
|  | client            |       | api                |       | worker                  |  |
|  | Node 22 / React   | ----> | Node 22 + Express  | <---> | Node 22 + BullMQ        |  |
|  | Port 3000         |       | yt-dlp + FFmpeg    |       | yt-dlp + FFmpeg         |  |
|  +-------------------+       +--------------------+       +-------------------------+  |
|                                        |                              |                |
|                                        v                              v                |
|                              +--------------------+       +-------------------------+  |
|                              | mongo:7            |       | redis:7-alpine          |  |
|                              | Port 27017         |       | Port 6379               |  |
|                              +--------------------+       +-------------------------+  |
|                                        ^                              ^                |
|                                        |                              |                |
|                                        +-------- Local Volume --------+                |
|                                                 ./data/downloads                       |
|                                                 ./data/cookies                         |
+----------------------------------------------------------------------------------------+
```

### 4.2 Shared Docker Volumes
* `./data/downloads`: Shared temporary directory mounted into both `api` and `worker` containers. Files stored here have a 30-minute Time-To-Live (TTL).
* `./data/cookies`: Mounted read-only into `api` and `worker` containers. Contains domain-specific Netscape cookie files (`youtube.txt`, etc.).

---

## 5. Data Models & Database Schemas

### 5.1 MongoDB Schemas

#### User Schema (`users`)
```javascript
const UserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
```

#### Job Schema (`jobs`)
```javascript
const JobSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  batchId: { type: String, default: null }, // Groups items from a playlist inspection
  sourceUrl: { type: String, required: true },
  platform: { type: String, match: /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/, required: true }, // known slug or derived registrable domain
  title: { type: String, default: 'Media File' },
  thumbnail: { type: String },
  mode: { type: String, enum: ['video', 'audio'], required: true },
  container: { type: String, enum: ['mp4', 'mkv', 'webm', 'mp3'], required: true },
  formatSelector: { type: String, required: true }, // e.g. "137+140" or "bestvideo[height<=1080]+bestaudio"
  useCookies: { type: Boolean, default: false },
  status: { 
    type: String, 
    enum: ['queued', 'downloading', 'muxing', 'ready', 'failed', 'expired'], 
    default: 'queued' 
  },
  progress: { type: Number, min: 0, max: 100, default: 0 },
  filePath: { type: String, default: null },
  fileSizeBytes: { type: Number, default: 0 },
  errorMessage: { type: String, default: null },
  expiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

JobSchema.index({ userId: 1, createdAt: -1 });
JobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // MongoDB TTL auto-cleanup index
```

---

## 6. REST API Endpoints Specification

### 6.1 Authentication
* `POST /api/auth/register` — Registers initial user (returns 403 if `ALLOW_REGISTRATION=false`).
* `POST /api/auth/login` — Sets HTTP-only JWT auth cookie.
* `POST /api/auth/logout` — Clears JWT cookie.
* `GET /api/auth/me` — Returns current authenticated user state.

### 6.2 Metadata Inspection
* `POST /api/inspect`
  * **Payload:** `{ "url": "https://...", "useCookies": false }`
  * **Response:**
    ```json
    {
      "isPlaylist": false,
      "title": "Sample Video Title",
      "thumbnail": "https://...",
      "duration": 240,
      "platform": "youtube",
      "formats": [
        {
          "formatId": "direct-720p",
          "label": "720p (Direct Download)",
          "container": "mp4",
          "isDirect": true,
          "directUrl": "https://googlevideo.com/..."
        },
        {
          "formatId": "137+140",
          "label": "1080p HD (Fast Stream Copy)",
          "container": "mp4",
          "isDirect": false,
          "vcodec": "h264",
          "acodec": "aac"
        },
        {
          "formatId": "bestaudio",
          "label": "MP3 Audio (320kbps)",
          "container": "mp3",
          "isDirect": false
        }
      ]
    }
    ```
  * **Playlist Response:** Returns `isPlaylist: true` with an array of `items` (`title`, `url`, `thumbnail`, `duration`).

### 6.3 Media Execution & Proxy
* `GET /api/proxy`
  * **Query Params:** `?url=<encoded_url>&filename=<name>&referer=<ref>`
  * **Behavior:** Directly streams external media bytes to the HTTP response pipe with `Content-Disposition: attachment`.
* `POST /api/jobs`
  * **Payload:**
    ```json
    {
      "url": "https://...",
      "items": [
        { "title": "Track 1", "formatSelector": "bestvideo[height<=1080]+bestaudio", "container": "mp4" }
      ],
      "useCookies": false
    }
    ```
  * **Behavior:** Enqueues BullMQ tasks and creates database `Job` records. Returns an array of created Job IDs.
* `GET /api/jobs` — Fetches current user's job history and status.
* `GET /api/jobs/:id` — Polled by UI every 2.5 seconds to track job progress.
* `GET /api/jobs/:id/file` — Downloads finished output file from disk (`/data/downloads`).

### 6.4 Cookie Management
* `GET /api/cookies` — Lists installed cookie files for any safe platform slug (`youtube.txt`, `tiktok.com.txt`, etc.).
* `POST /api/cookies/:platform` — Accepts text/file payload of Netscape formatted `cookies.txt` for any safe platform slug.
* `DELETE /api/cookies/:platform` — Removes the specified cookie file.

---

## 7. Technical Implementation Details & Execution Rules

### 7.1 Stream-Copy Container Resolution Matrix
To guarantee fast muxing (<5 seconds per 10-minute video) without re-encoding video streams:

```
                  +-----------------------------------+
                  |   yt-dlp Format Extraction        |
                  +-----------------------------------+
                                    |
                    +---------------+---------------+
                    |                               |
           [Video Codec Check]             [Audio Extraction]
                    |                               |
    +---------------+---------------+               v
    |                               |         Audio Only:
  H.264 / AAC                   VP9 / Opus    Target: MP3
    |                               |         FFmpeg Command:
    v                               v         yt-dlp -x --audio-format mp3
 Target: MP4                     Target: WebM --audio-quality 0
 FFmpeg Flag:                    FFmpeg Flag:
 -c copy                         -c copy
```

* **Fallback Container:** If mismatched video/audio codecs are requested in an MP4 container, default the container target to **MKV** with `-c copy`. MKV acts as a universal container for any codec combination without requiring CPU re-encoding.

### 7.2 Security & System Guardrails
* **No Public Abuse Risk:** System operates under authentication guardrails (`ALLOW_REGISTRATION=false` after initial setup).
* **Network Isolation:** Express proxy strictly rejects internal subnet ranges (`127.0.0.1`, `10.0.0.0/8`, `192.168.0.0/16`) to prevent Server-Side Request Forgery (SSRF).
* **Sanitized Filenames:** All output file names are sanitized to remove special characters, replacing whitespace with underscores and keeping only alphanumeric characters.
* **Storage Auto-Cleanup Cron:** A recurring background service in `worker.js` runs every 15 minutes, removing files older than 30 minutes from `/data/downloads` and updating the corresponding MongoDB `Job` record to `status: 'expired'`.

---

## 8. Implementation Roadmap

### Phase 1 — Docker Infrastructure & Direct Proxy Fast Path
- [x] Configure Docker Compose service definitions (`api`, `client`, `mongo`, `redis`, `worker`).
- [x] Setup `node:22-slim` base image with `ffmpeg`, `python3`, and `yt-dlp[default]`.
- [x] Implement `/api/inspect` endpoint with basic JSON extraction.
- [x] Implement `/api/proxy` streaming endpoint for direct single-file downloading.

### Phase 2 — BullMQ Queue & Stream-Copy Worker Logic
- [x] Integrate Redis & BullMQ job queue architecture.
- [x] Build `worker.js` spawn wrapper parsing stdout progress (`yt-dlp --newline`).
- [x] Implement fast stream-copy muxing logic for MP4, WebM, and MKV formats.
- [x] Implement MP3 audio extraction pipeline.
- [x] Add automated 30-minute local disk storage cleanup task.

### Phase 3 — Authentication, Cookie Management & Playlist Inspection
- [x] Build JWT authentication flow with registration toggle guard.
- [x] Create cookie management system allowing Netscape `cookies.txt` uploads per domain.
- [x] Implement selective playlist inspection (`yt-dlp --flat-playlist`) and UI checkbox picker.
- [x] Support multi-job batch queueing for playlist selections.

### Phase 4 — UI Polish, Cloudflare Tunnel & Maintenance Tools
- [x] Build responsive Tailwind dashboard with live progress polling drawer.
- [x] Add Cloudflare Tunnel (`cloudflared`) Docker profile for secure phone/remote access.
- [x] Add zero-downtime `yt-dlp` update utility script (`docker compose exec api yt-dlp -U`).