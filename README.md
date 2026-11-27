# MediaVault

A private, self-hosted media downloader web app powered by `yt-dlp` (1,752 extractors across ~1,375 providers — YouTube, YouTube Music, TikTok, Vimeo, SoundCloud, Instagram, X, Facebook, Dailymotion, and hundreds more), packaged as a single unified Alpine image ([`omprasannasahoo181/mediavault`](https://hub.docker.com/r/omprasannasahoo181/mediavault)) for a ₹0 local Docker Compose stack.

---

## Quick Start (Recommended — No Clone Needed)

Pull and run MediaVault with MongoDB and Redis using the standalone [`docker-compose.yml`](https://github.com/omprasanna/MediaVault/blob/main/docker/yt-downloader/docker-compose.yml):

### Windows (PowerShell)

```powershell
mkdir mediavault; cd mediavault
curl.exe -fsSLO https://raw.githubusercontent.com/omprasanna/MediaVault/main/docker/yt-downloader/docker-compose.yml
docker compose up -d
```

### macOS / Linux

```sh
mkdir -p mediavault && cd mediavault
curl -fsSLO https://raw.githubusercontent.com/omprasanna/MediaVault/main/docker/yt-downloader/docker-compose.yml
docker compose up -d
```

Open **`http://localhost:3000`** in your browser.

- **Zero-config JWT secret:** If `JWT_SECRET` is omitted, MediaVault automatically generates a cryptographically strong secret on first boot and persists it in the `mediavault_config` volume.
- **Default downloads folder:** Finished files are saved to `~/Downloads/MediaVault` (override via `HOST_DOWNLOADS_DIR`).
- **Update to the newest image later:**

  ```powershell
  docker compose pull
  docker compose up -d
  ```

---

## Architecture

MediaVault runs inside a dedicated Docker bridge network (`mediavault-net`):

| Service | Purpose |
| :--- | :--- |
| `mediavault` | Unified Next.js UI, Express REST API, BullMQ worker, `yt-dlp[curl-cffi]`, `ffmpeg`, and bundled `cloudflared` |
| `mongo` | MongoDB 7 persistence (`users`, `jobs`, `batches`, `cookies` metadata) |
| `redis` | Redis 7 backing BullMQ job queues and live download progress |
| `cloudflared` | *(Optional, repo [`docker-compose.yml`](https://github.com/omprasanna/MediaVault/blob/main/docker-compose.yml) with `--profile tunnel`)* Named Cloudflare Tunnel for custom domains |

---

## Configuration (Optional `.env`)

Create a `.env` file next to `docker-compose.yml` (see [`.env.example`](https://github.com/omprasanna/MediaVault/blob/main/.env.example)) to override any defaults:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CLIENT_PORT` | `3000` | Host port exposed for the web UI |
| `HOST_DOWNLOADS_DIR` | `~/Downloads/MediaVault` *(or `./data/downloads` in repo)* | Host directory mounted to `/data/downloads` |
| `ALLOW_REGISTRATION` | `true` | Allow creating new operator accounts (`false` after setup) |
| `COOKIE_SECURE` | `false` | Set `true` when serving strictly over HTTPS + `localhost` |
| `JWT_SECRET` | *(auto-generated)* | Custom 32+ character signing secret |
| `DOWNLOAD_TTL_MINUTES` | `30` | Minutes before files expire (`0` keeps files permanently) |
| `WORKER_CONCURRENCY` | `2` | Simultaneous download/mux workers |
| `MAX_PLAYLIST_ITEMS` | `0` | Max playlist items per inspection (`0` = unlimited) |
| `MAX_BATCH_ITEMS` | `0` | Max jobs per batch enqueue (`0` = unlimited) |

---

## Security Lockdown Checklist (Daily Self-Hosted Use)

Follow these steps before exposing MediaVault on your phone or external network:

1. **Register your personal account**
   - Open `http://localhost:3000/login`, switch to account creation, and register your operator account (`ALLOW_REGISTRATION=true` by default on first run).

2. **Disable public registration in `.env`**
   ```env
   ALLOW_REGISTRATION=false
   COOKIE_SECURE=true
   ```
   *(Set `COOKIE_SECURE=true` if accessing over `https://` via Cloudflare Tunnel.)*

3. **Recreate `mediavault` to apply `.env`**
   ```powershell
   docker compose up -d mediavault
   ```
   > Use `docker compose up -d` — **not** `docker compose restart`, which does not reload edited `.env` values.

   Verify registration is locked (`403 Forbidden` with `REGISTRATION_DISABLED`):
   ```powershell
   curl.exe -sS -i -X POST http://localhost:3000/api/auth/register `
     -H "Content-Type: application/json" `
     -d '{"email":"blocked@mediavault.local","password":"Password123!"}'
   ```

---

## Remote Access via Cloudflare Tunnel

### Option A — Instant Temporary URL (Built-in, No Account Required)

1. Ensure MediaVault is running and open `http://localhost:3000` in your browser.
2. Click **Remote** in the top navigation bar — MediaVault uses the bundled `cloudflared` binary to open a temporary `https://*.trycloudflare.com` Quick Tunnel and shows **Copy**.
3. Click **Stop tunnel** when finished. *(Quick Tunnel URLs change on every start.)*

### Option B — Permanent Custom Domain (Named Cloudflare Tunnel)

Use this option with the repository [`docker-compose.yml`](https://github.com/omprasanna/MediaVault/blob/main/docker-compose.yml) if you have a domain managed on Cloudflare:

1. Ensure `ALLOW_REGISTRATION=false` and `COOKIE_SECURE=true` are set in `.env` and applied (`docker compose up -d mediavault`).
2. In **Cloudflare Zero Trust Dashboard → Networks → Tunnels → Create a tunnel → Cloudflared**, copy the tunnel token (`eyJhIjoi...`).
3. Under **Public Hostname**, point your subdomain (e.g. `media.yourdomain.com`) to **HTTP** URL `mediavault:3000`.
4. Add the token to `.env`:
   ```env
   CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...
   ```
5. Start and manage the tunnel:
   ```powershell
   docker compose --profile tunnel up -d
   docker compose --profile tunnel logs --tail 25 cloudflared
   ```
   Open `https://<your-public-hostname>` from any device, and run `docker compose --profile tunnel stop cloudflared` when finished.

---

## Supported Sites & Cookies

- **1,752 extractors across ~1,375 providers:** MediaVault forwards any public `http://` or `https://` URL to the bundled `yt-dlp` build while pinning DNS to validated public IPs (blocking private/loopback/link-local SSRF targets). Inspect the live provider list in **Settings → Supported Sites** or via `GET /api/system/providers`.
- **Any-site cookie upload:** For age-restricted, bot-checked, or login-walled non-DRM videos, export Netscape `cookies.txt` in your browser, go to **Settings → Platform Cookies → Add cookies for any site**, enter the site domain (e.g. `hotstar.com`, `vimeo.com`, or select YouTube/Instagram/X/Facebook), upload `.txt`, and enable **Use saved cookies** on the Downloader page. *(DRM-protected streams cannot be downloaded by `yt-dlp`.)*

---

## Playlists & Persistent Downloads Storage

- **Unlimited playlists:** `MAX_PLAYLIST_ITEMS=0` and `MAX_BATCH_ITEMS=0` inspect and queue full playlists.
- **Readable filenames & playlist folders:** Completed downloads move from `.mediavault-tmp` into `HOST_DOWNLOADS_DIR` with clean filenames (`_(2)`, `_(3)` on duplicates) and `<Playlist_Title>/` subfolders for batches.
- **Keep files permanently:** Set `DOWNLOAD_TTL_MINUTES=0` in `.env` (or keep `30` to auto-purge after 30 minutes) and recreate `mediavault` (`docker compose up -d mediavault`). Live total file sizes appear during download and in Queue & History.

---

## Building from Source (Optional)

Clone the repository and build locally from [`Dockerfile`](https://github.com/omprasanna/MediaVault/blob/main/Dockerfile):

```powershell
git clone https://github.com/omprasanna/MediaVault.git
cd MediaVault
Copy-Item .env.example .env
# Generate a 64-char JWT secret into .env
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
docker compose up -d --build
```

To force-update the bundled `yt-dlp` release when building from source, run `docker compose build --no-cache && docker compose up -d`.
