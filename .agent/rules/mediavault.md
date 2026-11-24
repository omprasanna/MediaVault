# MediaVault Workspace Rules

- Architecture: Strict ₹0 self-hosted local Docker stack. Never add paid APIs, S3/R2 SDKs, or external SaaS dependencies.
- Frontend: Next.js (App Router) + TypeScript + Tailwind CSS in `client/` with `output: 'standalone'`.
- Frontend Design System:
  - Always reference `docs/DESIGN.md` for all frontend UI/UX, theming, typography, spacing, border/shadow, and responsive navigation tasks.
  - Never hardcode raw hex color values (`#...`) anywhere outside `client/src/app/globals.css`. Always consume semantic CSS custom properties (`var(--...)`) or Tailwind theme tokens mapped in `globals.css`.
  - Use `Inter` for UI headings/labels and `JetBrains Mono` with `tabular-nums` (`font-variant-numeric: tabular-nums`) for URLs, durations, file sizes, transfer rates, progress percentages, and technical badges.
  - Preserve the responsive shell rules in `docs/DESIGN.md`: desktop (`>= 768px`) sticky top bar navigation and mobile (`< 768px` / `390px`) compact header + fixed bottom tab bar (`>= 44px` touch targets).
- Backend: Node.js + Express in `server/` (shared image for `api` and `worker` containers), MongoDB (Mongoose), Redis + BullMQ.
- Docker Base Image: Always use `node:22-slim` (never Alpine) for `server/Dockerfile` so Python 3, `ffmpeg`, and `yt-dlp[default]` run cleanly.
- Media Rules:
  - Always invoke `yt-dlp` with `--js-runtimes node`.
  - Cap video resolution at 1080p.
  - Stream-copy muxing ONLY (`-c copy` / native compatible codecs). Never re-encode video streams. Audio extraction to MP3 is allowed.
  - Attach `--cookies` only when the user explicitly toggles `useCookies: true`.
- Source of Truth: Strictly follow `docs/prd_multi_platform_media_downloader.md`, `docs/system_design_multi_platform_media_downloader.md`, and `docs/db_and_api_specification_multi_platform_media_downloader.md` for data models and JSON contracts, and `docs/DESIGN.md` for UI/UX design tokens and layouts.
- Discipline: Always verify changes by running a concrete CLI, `curl`, or Docker check before declaring a step done.
