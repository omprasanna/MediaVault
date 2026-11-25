# MediaVault

A private, self-hosted multi-platform media downloader web app (supports YouTube, YouTube Music, Instagram, X, Facebook, and Dailymotion) built for a ₹0 local Docker Compose stack.

---

## Architecture

MediaVault runs inside a dedicated Docker network (`mediavault-net`) composed of six services configured in [docker-compose.yml](./docker-compose.yml) and [docker-compose.prod.yml](./docker-compose.prod.yml):

| Service | Purpose |
| :--- | :--- |
| `mongo` | MongoDB 7 persistence (`users`, `jobs`, `batches`, `cookies` metadata) |
| `redis` | Redis 7 backing BullMQ job queues and transient download telemetry |
| `api` | Node.js + Express REST API, JWT auth, fast-path `/api/proxy`, and `/api/system` |
| `worker` | BullMQ worker (`concurrency: 2`, `--js-runtimes node`, 1080p stream-copy muxing & MP3 extraction, clean-filename persistent host Downloads storage) |
| `client` | Next.js App Router UI (`dev` HMR target by default; Next.js `standalone` `prod` target via `docker-compose.prod.yml`) |
| `cloudflared` | Optional Cloudflare Tunnel (`profiles: ["tunnel"]`) for encrypted phone/remote access |

---

## Quick Start

1. Create your local environment file from `.env.example` and generate a cryptographically secure `JWT_SECRET`:

   ```powershell
   Copy-Item .env.example .env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Paste the generated 64-character hex value into `JWT_SECRET=` in `.env` (or use `openssl rand -hex 32`).

2. Start the stack:

   - **Local development** (with source hot reload):
     ```powershell
     docker compose up -d --build
     ```
   - **Daily production mode** (Next.js `standalone` build + `unless-stopped` restarts):
     ```powershell
     docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
     ```

3. Open `http://localhost:3000`.

---

## Security Lockdown Checklist (Daily Self-Hosted Use)

Follow these steps in order before exposing MediaVault on a phone or external network:

1. **Register your personal account**
   - Ensure `ALLOW_REGISTRATION=true` in `.env` during initial setup.
   - Open `http://localhost:3000/login`, switch to account creation, and register your personal operator account.

2. **Disable public registration in `.env`**
   - Open `.env` and change:
     ```env
     ALLOW_REGISTRATION=false
     ```

3. **Recreate `api` to apply the updated `.env`**
   - Run:
     ```powershell
     docker compose up -d api
     ```
     *(In production mode: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d api`.)*
   - **Important:** Use `docker compose up -d api` — **not** `docker compose restart api`. `restart` reuses the existing container environment and does not reload edited `.env` values.
   - Verify registration is locked (`403 Forbidden` with `REGISTRATION_DISABLED`):
     ```powershell
     curl.exe -sS -i -X POST http://localhost:5000/api/auth/register `
       -H "Content-Type: application/json" `
       -d '{"email":"blocked@mediavault.local","password":"Password123!"}'
     ```

4. **Start Cloudflare Tunnel on demand (Optional Phone / Remote Access)**
   - In the **Cloudflare Zero Trust Dashboard** (**Networks → Tunnels → Create a tunnel → Cloudflared**):
     1. Copy your tunnel token into `.env`:
        ```env
        CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...
        ```
     2. Under the tunnel's **Public Hostname** tab, configure your hostname to route traffic to the internal Docker origin **`http://client:3000`**.
   - *(Optional HTTPS hardening)* When accessing MediaVault strictly over HTTPS (via Cloudflare Tunnel) and `localhost`, set `COOKIE_SECURE=true` in `.env` and recreate `api` (`docker compose up -d api`) so the `jwt` auth cookie carries the `Secure` attribute.
   - **Start the tunnel when needed:**
     ```powershell
     docker compose --profile tunnel up -d
     ```
     *(Or in production mode: `docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile tunnel up -d`.)*
   - **Stop the tunnel when finished:**
     ```powershell
     docker compose --profile tunnel stop cloudflared
     ```
   - **Ad-hoc Quick Tunnel (without a named tunnel token):**
     If you only need a temporary `*.trycloudflare.com` URL without configuring a dashboard token, run:
     ```powershell
     docker compose --profile tunnel run --rm -e TUNNEL_TOKEN= cloudflared tunnel --no-autoupdate --url http://client:3000
     ```

---

## Updating `yt-dlp`

Whenever upstream platform extractor changes break inspection or downloads, rebuild the `api` and `worker` images without cache using [scripts/update-ytdlp.ps1](./scripts/update-ytdlp.ps1):

```powershell
# Development compose stack
.\scripts\update-ytdlp.ps1

# Production override stack
.\scripts\update-ytdlp.ps1 -Prod
```

---

## Full Playlists & Persistent Downloads Storage

- **Unlimited Playlists:** `MAX_PLAYLIST_ITEMS=0` and `MAX_BATCH_ITEMS=0` in `.env` inspect and queue the full length of any playlist without the legacy 50/100 item cap. Set positive values in `.env` if you want to enforce caps on shared instances.
- **Persistent Host Downloads (`DOWNLOAD_TTL_MINUTES=0`):** Active downloads stage briefly inside `.mediavault-tmp` and move directly into `HOST_DOWNLOADS_DIR` (`./data/downloads` by default) using sanitized human-readable filenames (with `_(2)`, `_(3)` suffixing on duplicate titles). Playlist batches are automatically grouped into `<Playlist_Title>/` subfolders.
- **Point Directly to Your OS Downloads Folder:** Set `HOST_DOWNLOADS_DIR=C:/Users/<YourName>/Downloads/MediaVault` in `.env` and recreate `api` and `worker` (`docker compose up -d api worker`) so completed videos/MP3s land straight in your local Downloads folder.
- **Manual Deletion & Remote Downloads:** Files persist until deleted manually from your host folder or via the delete button (`DELETE /api/jobs/:id`) on `/queue`. `Save File` remains active for phone/remote downloads over Cloudflare Tunnel. If you prefer automatic deletion after 30 minutes, set `DOWNLOAD_TTL_MINUTES=30` in `.env`.
