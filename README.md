# MediaVault

A private, self-hosted multi-platform media downloader web app (supports YouTube, YouTube Music, Instagram, X, Facebook, and Dailymotion) built for a ₹0 local Docker Compose stack.

---

## Architecture

MediaVault runs inside a dedicated Docker network (`mediavault-net`) configured in [docker-compose.yml](./docker-compose.yml). The app, API, and worker run together in one container alongside MongoDB and Redis:

| Service | Purpose |
| :--- | :--- |
| `mongo` | MongoDB 7 persistence (`users`, `jobs`, `batches`, `cookies` metadata) |
| `redis` | Redis 7 backing BullMQ job queues and transient download telemetry |
| `mediavault` | Unified Next.js UI, Node.js + Express REST API, and BullMQ worker |
| `cloudflared` | Optional Cloudflare Tunnel (`profiles: ["tunnel"]`) for encrypted phone/remote access |

---

## Quick Start

1. Create your local environment file from `.env.example` and generate a cryptographically secure `JWT_SECRET`:

   ```powershell
   Copy-Item .env.example .env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Paste the generated 64-character hex value into `JWT_SECRET=` in `.env` (or use `openssl rand -hex 32`).

2. Pull the published app image and start the stack:
   ```powershell
   docker compose pull mediavault
   docker compose up -d
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

3. **Recreate the app container to apply the updated `.env`**
   ```powershell
   docker compose up -d mediavault
   ```
   - **Important:** Use `up -d` — **not** `docker compose restart`. `restart` reuses the existing container environment and does not reload edited `.env` values.
   - Verify registration is locked (`403 Forbidden` with `REGISTRATION_DISABLED`):
     ```powershell
     curl.exe -sS -i -X POST http://localhost:3000/api/auth/register `
       -H "Content-Type: application/json" `
       -d '{"email":"blocked@mediavault.local","password":"Password123!"}'
     ```

4. **Enable HTTPS-only cookies (if exposing remotely via Cloudflare Tunnel)**
   - When accessing MediaVault over HTTPS (`https://*.trycloudflare.com` or your custom Cloudflare domain) and `localhost`, set `COOKIE_SECURE=true` in `.env` and recreate the container with `docker compose up -d mediavault` before starting the tunnel below.

---

## Remote Access via Cloudflare Tunnel (Step-by-Step)

You can expose MediaVault on an encrypted `https://` URL for your phone or remote devices using either an instant temporary Quick Tunnel or a permanent Named Tunnel.

### Option A — Instant Temporary URL (`*.trycloudflare.com`, no account required)

1. Make sure the MediaVault stack is running and open MediaVault in your browser.
2. Select **Remote** in the top bar. MediaVault starts a temporary Cloudflare Quick Tunnel and displays its URL; use **Copy** to share it. Select **Stop tunnel** when remote access is no longer needed. The URL changes each time you restart the tunnel.

The app image includes `cloudflared`. For HTTPS-only cookies, set `COOKIE_SECURE=true` in `.env` and recreate the app container before starting the tunnel.

You can also start a Quick Tunnel manually:

1. **Make sure the MediaVault stack is already running:**
   ```powershell
   docker compose up -d
   ```

2. **Start a Quick Tunnel and get your HTTPS URL:**
   Do **not** use `http://localhost:3000` inside the `--url` flag — inside the `cloudflared` container, `localhost` points to `cloudflared` itself. Use the Compose service name, `http://mediavault:3000`:
   ```powershell
   docker compose --profile tunnel run --rm --no-deps -e TUNNEL_TOKEN= cloudflared tunnel --no-autoupdate --url http://mediavault:3000 2>&1 | ForEach-Object {
     $line = "$_"
     if ($line -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
       $Matches[1]
     } elseif ($line -match '\b(ERR|WRN)\b') {
       $line
     }
   }
   ```
   This prints the temporary URL without the routine startup logs, while still showing warnings/errors. Press `Ctrl+C` to stop the tunnel.

3. **Connect:** Open the printed URL in your phone or remote browser and sign in with your MediaVault account. Quick Tunnel URLs change every time you restart the tunnel.

---

### Option B — Permanent Custom Domain URL (Named Tunnel via Cloudflare Zero Trust)

Use this option if you own a domain on Cloudflare and want a fixed URL (for example `https://media.yourdomain.com`).

1. **Lock registration & enable secure cookies in `.env`:**
   ```env
   ALLOW_REGISTRATION=false
   COOKIE_SECURE=true
   ```
   Recreate MediaVault to apply `.env`:
   ```powershell
   docker compose up -d mediavault
   ```

2. **Create a Tunnel in the Cloudflare Zero Trust Dashboard:**
   - Go to **Networks → Tunnels → Create a tunnel → Cloudflared**, give it a name (e.g., `mediavault`), and click **Save tunnel**.
   - Under **Choose your environment → Docker**, copy the tunnel token (`eyJhIjoi...`).

3. **Set the Public Hostname & internal Docker origin:**
   - Open the tunnel's **Public Hostname** tab and click **Add a public hostname**.
   - Enter your subdomain & domain (e.g., `media.yourdomain.com`).
   - Set **Type** to **`HTTP`** and **URL** to `mediavault:3000`.

4. **Save the token in `.env`:**
   ```env
   CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...
   ```

5. **Start the tunnel and verify the connection:**
   ```powershell
   docker compose --profile tunnel up -d
   docker compose --profile tunnel logs --tail 25 cloudflared
   ```

   Look for `Registered tunnel connection` in the logs.

6. **Connect & stop when finished:**
   - Open `https://<your-public-hostname>` (e.g., `https://media.yourdomain.com`) from any device and sign in.
   - Stop the tunnel whenever remote access is no longer needed:
     ```powershell
     docker compose --profile tunnel stop cloudflared
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
