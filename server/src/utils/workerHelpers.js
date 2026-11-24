const fs = require('fs');
const { AppError } = require('./errors');

const SAFE_SELECTOR_REGEX = /^[a-zA-Z0-9_+[\]<=.,\-/*()^$~"':\s]+$/;

const DEFAULT_SELECTORS = {
  audio: 'bestaudio/best',
  mp4: 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]',
  webm: 'bestvideo[height<=1080][vcodec~="^(vp0?9|av01)"]+bestaudio[acodec^=opus]/bestvideo[height<=1080][ext=webm]+bestaudio[ext=webm]/best[height<=1080]',
  mkv: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
};

/**
 * Returns the default <=1080p stream-copy-friendly yt-dlp format selector.
 *
 * @param {'video' | 'audio'} mode
 * @param {'mp4' | 'webm' | 'mkv' | 'mp3'} container
 * @returns {string}
 */
function getDefaultFormatSelector(mode, container) {
  if (mode === 'audio' || container === 'mp3') {
    return DEFAULT_SELECTORS.audio;
  }
  return DEFAULT_SELECTORS[container] || DEFAULT_SELECTORS.mkv;
}

/**
 * Validates and enforces a 1080p height cap on custom yt-dlp format selectors.
 *
 * @param {string | undefined | null} selector
 * @param {'video' | 'audio'} mode
 * @param {'mp4' | 'webm' | 'mkv' | 'mp3'} container
 * @returns {string}
 */
function enforce1080pSelector(selector, mode, container) {
  const trimmed = typeof selector === 'string' ? selector.trim() : '';
  if (!trimmed) {
    return getDefaultFormatSelector(mode, container);
  }

  if (trimmed.length > 200 || !SAFE_SELECTOR_REGEX.test(trimmed)) {
    throw new AppError(400, 'INVALID_REQUEST', 'Invalid formatSelector value.');
  }

  if (mode === 'audio' || container === 'mp3') {
    return trimmed;
  }

  // Reject explicit >1080p height filters.
  const heightMatch = trimmed.match(/height\s*[<=>]+\s*(\d+)/gi);
  if (heightMatch) {
    for (const clause of heightMatch) {
      const val = Number(clause.replace(/[^\d]/g, ''));
      if (Number.isFinite(val) && val > 1080) {
        return getDefaultFormatSelector(mode, container);
      }
    }
    return trimmed;
  }

  // Inject [height<=1080] onto bare `bestvideo` / `best` selectors.
  if (/\b(bestvideo|best)\b/i.test(trimmed)) {
    return trimmed.replace(/\b(bestvideo|best)\b(?!\s*\[[^\]]*height)/gi, '$1[height<=1080]');
  }

  return trimmed;
}

/**
 * Builds an argument array for `child_process.spawn('yt-dlp', ...)` enforcing:
 * - `--js-runtimes node`
 * - `--newline` progress output
 * - Stream-copy muxing (`-c copy`) for video containers or 320kbps MP3 extraction
 * - `--cookies` ONLY when `cookiePath` is explicitly provided
 *
 * @param {{ url: string, mode: 'video' | 'audio', container: 'mp4' | 'webm' | 'mkv' | 'mp3', formatSelector: string, outputTemplate: string, cookiePath?: string | null }} params
 * @returns {string[]}
 */
function buildYtDlpJobArgs({
  url,
  mode,
  container,
  formatSelector,
  outputTemplate,
  cookiePath = null,
}) {
  const safeSelector = enforce1080pSelector(formatSelector, mode, container);
  const args = [
    '--js-runtimes',
    'node',
    '--newline',
    '--no-playlist',
    '--no-warnings',
  ];

  if (process.env.YTDLP_FORCE_IPV4 !== 'false') {
    args.push('--force-ipv4');
  }

  if (mode === 'audio' || container === 'mp3') {
    args.push(
      '--format',
      safeSelector,
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0'
    );
  } else {
    args.push(
      '--format',
      safeSelector,
      '--merge-output-format',
      container,
      '--postprocessor-args',
      'Merger+ffmpeg_o:-c copy'
    );
  }

  if (cookiePath) {
    args.push('--cookies', cookiePath);
  }

  args.push('-o', outputTemplate, '--', url);
  return args;
}

const DOWNLOAD_PROGRESS_REGEX =
  /\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*([^\s]+))?(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/i;

/**
 * Parses a single yt-dlp stdout line for download progress metrics.
 *
 * @param {string} line
 * @returns {{ percentage: number, totalSize: string | null, downloadSpeed: string | null, eta: string | null } | null}
 */
function parseYtDlpProgressLine(line) {
  if (typeof line !== 'string' || !line.includes('[download]')) {
    return null;
  }

  const match = line.match(DOWNLOAD_PROGRESS_REGEX);
  if (!match) {
    return null;
  }

  const percentage = Math.min(100, Math.max(0, parseFloat(match[1])));
  if (!Number.isFinite(percentage)) {
    return null;
  }

  const rawSpeed = match[3] || null;
  const rawEta = match[4] || null;

  return {
    percentage,
    totalSize: match[2] || null,
    downloadSpeed: rawSpeed && rawSpeed.toLowerCase() !== 'unknown' ? rawSpeed : null,
    eta: rawEta && rawEta.toLowerCase() !== 'unknown' ? rawEta : null,
  };
}

/**
 * Detects when yt-dlp transitions from stream downloading into FFmpeg muxing or audio extraction.
 *
 * @param {string} line
 * @returns {boolean}
 */
function detectMuxingPhase(line) {
  if (typeof line !== 'string') return false;
  return /^\[(Merger|ExtractAudio|Fixup|ffmpeg)\]/i.test(line.trim());
}

/**
 * Verifies free disk space in the downloads directory meets `MIN_FREE_DISK_BYTES`.
 *
 * @param {string} targetDir
 * @returns {Promise<{ freeBytes: number, minRequiredBytes: number }>}
 */
async function assertSufficientDiskSpace(targetDir) {
  const minRequiredBytes = Number(process.env.MIN_FREE_DISK_BYTES || 2147483648);
  await fs.promises.mkdir(targetDir, { recursive: true });
  const stats = await fs.promises.statfs(targetDir);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);

  if (freeBytes < minRequiredBytes) {
    throw new AppError(
      507,
      'DISK_FULL',
      'Insufficient free disk space to start download job.',
      { freeBytes, minRequiredBytes }
    );
  }

  return { freeBytes, minRequiredBytes };
}

module.exports = {
  getDefaultFormatSelector,
  enforce1080pSelector,
  buildYtDlpJobArgs,
  parseYtDlpProgressLine,
  detectMuxingPhase,
  assertSufficientDiskSpace,
};
