# System Design Document: Multi-Platform Media Downloader

**Project:** Self-Hosted Multi-Platform Media Downloader  
**Target Environment:** Single-Host Docker Topology (₹0 Budget)  
**Author / Architecture:** Senior Systems & Web Architect  

---

## 1. System High-Level Architecture

The system is designed around a decoupled micro-service model executing within a single Docker Network. It splits execution between **synchronous low-latency metadata inspection / proxy streaming** and **asynchronous queue-driven media processing**.

```
                           +------------------------+
                           |   Browser Client UI    |
                           |  (Vite + React + CSS)  |
                           +------------------------+
                             /          |         \
         1. GET /api/inspect/           |          \ 3. GET /api/proxy (Direct Stream)
                           /            |           \
                          v             |            v
               +--------------------+   |    +--------------------+
               |   Express API      |   |    | CDN Media Streamer |
               | (Control Plane)    |   |    | (Proxy Pipe Engine)|
               +--------------------+   |    +--------------------+
                 /        |        \    |
      2. Write  /         |         \   v 4. POST /api/jobs (Enqueue)
               v          |          +-----------------------------+
        +------------+    |                                        |
        |  MongoDB   |    |                                        v
        | (Database) |    |                             +--------------------+
        +------------+    |                             |    Redis Broker    |
                          |                             |  (BullMQ Engine)   |
                          |                             +--------------------+
                          v                                        |
               +--------------------+                              | 5. Pop Job
               | Local Disk Volume  |                              v
               | (/tmp/downloads)   | <-----------------+--------------------+
               +--------------------+  6. Render Output |  BullMQ Worker     |
                                                        | (Media Processor)  |
                                                        +--------------------+
```

---

## 2. Low-Level Component Specifications

### 2.1 Control Plane: Express API Server (`api`)
The API server handles authentication, client routing, URL inspection, direct byte streaming, and job creation.

* **Runtime:** Node.js 22 LTS (`node:22-slim` base image)
* **Key Modules:**
  * `ytdlpService.js`: Wraps `yt-dlp` CLI invocations with `--dump-single-json` or `--flat-playlist`.
  * `proxyController.js`: Manages backpressure-aware HTTP piping for direct downloads.
  * `jobController.js`: Inserts MongoDB job records and enqueues jobs onto BullMQ.
  * `authMiddleware.js`: Validates HTTP-only JWT cookies.

### 2.2 Execution Engine: BullMQ Media Worker (`worker`)
The media worker handles resource-intensive tasks: downloading video/audio streams, running stream-copy muxing via FFmpeg, extracting MP3 audio, and executing automated storage cleanup.

* **Runtime:** Node.js 22 LTS (shares container image with `api`, distinct entry point).
* **Concurrency:** Capped at $N = 2$ simultaneous workers to prevent CPU/Disk saturation on lower-spec host hardware.
* **Subprocess Management:** Uses Node.js `child_process.spawn` to capture streaming `stdout`/`stderr` from `yt-dlp` and `ffmpeg` in real time.

### 2.3 Data Persistence & State Store
1. **MongoDB 7.0 (`mongo`):**
   * Stores user credentials and job execution state (`queued`, `downloading`, `muxing`, `ready`, `failed`, `expired`).
   * Implements native TTL indexes (`expireAfterSeconds: 0`) on `expiresAt` timestamps for automated document cleanup.
2. **Redis 7.0 Alpine (`redis`):**
   * Acts as the transport layer and state broker for BullMQ.
   * Caches short-lived download progress updates to reduce database write operations.

---

## 3. Detailed Data Flows & Sequence Diagrams

### 3.1 Path A: Direct Byte-Proxy Streaming (Fast Path)

For single-stream progressive links (e.g., Instagram Reels, X clips, Facebook SD/HD, YouTube 720p progressive MP4), media is streamed straight to the user without touching the local server disk.

```
Client UI                   Express API                   yt-dlp CLI                Remote CDN
   |                             |                            |                         |
   |--- 1. POST /api/inspect --->|                            |                         |
   |                             |--- 2. Spawn --dump-json -->|                         |
   |                             |<-- 3. JSON Metadata -------|                         |
   |<-- 4. Return Format List ---|                            |                         |
   |                             |                            |                         |
   |--- 5. GET /api/proxy?url=...------------------------------------------------------>|
   |                             |                            |                         |
   |                             |<================ 6. Stream Bytes HTTP 200 ===========|
   |<================ 7. Pipe Response Bytes (Content-Disposition: attachment) ===========|
```

**Implementation Details for `proxyController.js`:**
```javascript
// HTTP Header Pass-Through Logic
const headers = {
  'User-Agent': req.query.userAgent || 'Mozilla/5.0...',
  'Referer': req.query.referer || '',
  'Cookie': req.query.cookie || ''
};

const externalStream = await fetch(targetMediaUrl, { headers });
res.setHeader('Content-Type', externalStream.headers.get('content-type'));
res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);
res.setHeader('Content-Length', externalStream.headers.get('content-length'));

// Pipe with native node stream backpressure handling
Readable.fromWeb(externalStream.body).pipe(res);
```

---

### 3.2 Path B: Asynchronous Worker Processing (Heavy Path)

For high-resolution 1080p downloads (requiring separate video + audio stream extraction and stream-copy muxing) or MP3 extractions.

```
Client UI              Express API              MongoDB              Redis / BullMQ              Worker Container
   |                        |                      |                       |                             |
   |-- 1. POST /api/jobs ->|                      |                       |                             |
   |                        |-- 2. Create Job ---->|                       |                             |
   |                        |   (status: queued)   |                       |                             |
   |                        |                      |                       |                             |
   |                        |----------------------3. Enqueue Job -------->|                             |
   |<-- 4. Return Job ID ---|                      |                       |                             |
   |                        |                      |                       |<-- 5. Pop Job Task ---------|
   |                        |                      |                       |                             |
   |                        |                      |<-- 6. Update status --|                             |-- 7. Spawn yt-dlp & FFmpeg
   |                        |                      |    ('downloading')    |                             |   (Parse stdout %)
   |                        |                      |                       |                             |
   |                        |                      |<-- 8. Update progress-------------------------------|
   |-- 9. GET /api/jobs/id->|                      |    (progress: 45%)    |                             |
   |<-- 10. Status & % -----|                      |                       |                             |
   |                        |                      |                       |                             |-- 11. Complete Muxing
   |                        |                      |<-- 12. Update Status -------------------------------|   (Write /tmp/file.mp4)
   |                        |                      |    ('ready', path)    |                             |
   |-- 13. Poll status ---->|                      |                       |                             |
   |<-- 14. Status: ready --|                      |                       |                             |
   |                        |                      |                       |                             |
   |-- 15. GET /api/jobs/:id/file ---------------------------------------------------------------------->| Reads /tmp file &
   |<==================== 16. Stream Download Bytes ====================================================| serves to browser
```

---

## 4. Subprocess Orchestration & Execution Logic

### 4.1 Stream-Copy Container Muxing Logic

To ensure fast performance without CPU-bound video re-encoding, the worker selects target containers strictly based on matching video and audio codecs.

$$\text{Muxing Strategy} = \begin{cases} 
\text{MP4 Container} & \text{if } v_{codec} = \text{H.264 (avc1)} \land a_{codec} = \text{AAC (mp4a)} \\
\text{WebM Container} & \text{if } v_{codec} = \text{VP9/AV1} \land a_{codec} = \text{Opus} \\
\text{MKV Container} & \text{for any mismatched codec pair (universal copy fallback)} \\
\text{MP3 Extraction} & \text{audio-only target (requires FFmpeg audio re-encode)}
\end{cases}$$

#### Spawn Execution Matrix:
1. **1080p MP4 Fast Stream-Copy:**
   ```bash
   yt-dlp \
     --format "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]" \
     --merge-output-format mp4 \
     --postprocessor-args "ffmpeg:-c copy" \
     --newline \
     -o "/tmp/downloads/%(id)s.%(ext)s" \
     "<URL>"
   ```

2. **MP3 Audio Extraction (High Quality 320kbps equivalent):**
   ```bash
   yt-dlp \
     --extract-audio \
     --audio-format mp3 \
     --audio-quality 0 \
     --newline \
     -o "/tmp/downloads/%(id)s.%(ext)s" \
     "<URL>"
   ```

### 4.2 Real-Time stdout Parsing Engine

The worker parses stdout from `yt-dlp` line-by-line using regular expressions to calculate smooth progress values for the frontend polling mechanism.

```javascript
// Regex for yt-dlp newline progress line parsing
// Example stdout: [download]  45.6% of ~120.50MiB at  2.45MiB/s ETA 00:15
const PROGRESS_REGEX = /\[download\]\s+(\d+\.\d+)%\s+of\s+~\s*(\d+\.\d+\w+)\s+at\s+(\d+\.\d+\w+\/s)\s+ETA\s+(\d+:\d+)/;

childProcess.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split('\n');
  for (const line of lines) {
    const match = line.match(PROGRESS_REGEX);
    if (match) {
      const percentage = parseFloat(match[1]);
      const downloadSpeed = match[3];
      const eta = match[4];

      // Throttle DB updates: write progress only if delta >= 2% or status changed
      updateJobProgressThrottle(jobId, percentage, downloadSpeed, eta);
    }
  }
});
```

---

## 5. Storage Lifecycle & Cleanup Engine

To prevent disk exhaustion on the host machine, the temporary download folder (`/tmp/downloads`) operates under a strict Time-To-Live (TTL) eviction policy.

```
       +-------------------------------------------------------------+
       |             Every 15 Minutes (Cron Worker)                  |
       +-------------------------------------------------------------+
                                      |
                                      v
                       +------------------------------+
                       | Scan /tmp/downloads Folder   |
                       +------------------------------+
                                      |
                                      v
                   /-------------------------------------\
                  /  Is file age > 30 minutes (1800s)?    \
                  \                                       /
                   \-------------------------------------/
                                |               |
                       YES      |               | NO
                                v               v
             +-----------------------+    +-------------------+
             | 1. Unlink File (fs)   |    | Keep File in Temp |
             | 2. Update Mongo Job:  |    +-------------------+
             |    status: 'expired'  |
             +-----------------------+
```

### Storage Cleanup Code Specification (`cleanupCron.js`):
```javascript
const fs = require('fs/promises');
const path = require('path');
const Job = require('../models/Job');

const TEMP_DIR = '/tmp/downloads';
const TTL_MS = 30 * 60 * 1000; // 30 Minutes

async function runStorageCleanup() {
  const now = Date.now();
  const files = await fs.readdir(TEMP_DIR);

  for (const file of files) {
    const filePath = path.join(TEMP_DIR, file);
    const stats = await fs.stat(filePath);

    if (now - stats.mtimeMs > TTL_MS) {
      await fs.unlink(filePath);
      await Job.updateMany(
        { filePath: filePath },
        { status: 'expired', filePath: null }
      );
    }
  }
}
```

---

## 6. Cookie Injection Architecture (Private / Age-Restricted Content)

To handle non-public, member-only, or age-gated videos across YouTube, Instagram, Facebook, and X, the system allows uploading Netscape-formatted `cookies.txt` files.

```
+------------------+         +----------------------------+         +--------------------------+
| Settings View    |         | Express Router             |         | Volume Mounted Disk      |
| (React Frontend) | ------> | POST /api/cookies/:domain  | ------> | ./data/cookies/          |
| Uploads file     |         | Validates Netscape Header  |         | youtube.txt (mode 0600)  |
+------------------+         +----------------------------+         +--------------------------+
                                                                                  |
                                                                                  v
                                                                    +--------------------------+
                                                                    | Worker / Subprocess      |
                                                                    | Appends flag:            |
                                                                    | --cookies /data/cookies/ |
                                                                    |           youtube.txt    |
                                                                    +--------------------------+
```

* **Security Guardrails for Cookie Files:**
  * Saved strictly inside `./data/cookies/<platform>.txt`.
  * Permissions set to `0600` (read/write by container owner only).
  * Automatically sanitized to prevent shell injection vectors in file paths.

---

## 7. Security Architecture & SSRF Defense

Even though this is a self-hosted tool, securing network inputs protects the host environment from Server-Side Request Forgery (SSRF) or arbitrary code execution.

1. **Generic Provider Validation:**
   MediaVault does not maintain a hostname allowlist. Any public HTTP(S) URL is accepted and handed to the bundled `yt-dlp` build, which ships 1,700+ extractors. Known platforms keep short platform IDs (`youtube`, `instagram`, `facebook`, `x`, `dailymotion`); every other URL gets a filename-safe registrable-domain slug (e.g. `www.tiktok.com` → `tiktok.com`) used for labels and per-site `<platform>.txt` cookie files. URLs with embedded credentials, non-HTTP schemes, and obviously restricted hostnames are rejected before any subprocess runs.

2. **Internal IP Blacklisting (SSRF Shield):**
   Before forwarding proxy requests or spawning subprocesses, DNS names are resolved to verify target IPs do not fall into private ranges:
   * `127.0.0.0/8` (Loopback)
   * `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (Private IPv4 Subnets)
   * `::1/128`, `fc00::/7` (IPv6 Private/Local)

3. **Subprocess Argument Isolation:**
   All execution calls use `child_process.spawn(executable, [argsArray])` instead of `exec()`. Passing parameters strictly as array elements eliminates shell string interpolation vulnerabilities.

---

## 8. Failure Modes & Recovery Strategies

| Failure Scenario | System Impact | Mitigation / Recovery Mechanism |
| :--- | :--- | :--- |
| **YouTube Platform Changes** | Metadata extraction returns HTTP 403 or parsing error. | Run background auto-update script: `docker compose exec api yt-dlp -U`. System notifies user via UI error state: *"Extractor outdated, update pending"*. |
| **FFmpeg Mux Error** | Video and Audio fail to merge into target container. | Worker catches process exit code $\neq 0$, falls back to container `MKV` format with `-c copy`, and logs fallback event. |
| **Out of Memory (OOM)** | Large file download exceeds worker memory limits. | Worker uses Node.js streams instead of loading file buffers into memory; Docker container enforces `mem_limit: 2g`. |
| **Disk Capacity Reached** | Host storage runs low on disk space. | Pre-flight disk space check before download spawn. If free space is below $2\text{ GB}$, trigger immediate cleanup cycle and throw error to user. |