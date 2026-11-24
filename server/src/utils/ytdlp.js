const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppError } = require('./errors');
const { assertPublicUrl } = require('./ssrf');

const ALLOWED_PLATFORMS = ['youtube', 'instagram', 'facebook', 'x', 'dailymotion'];

const HOST_PLATFORM_MAP = {
  'youtube.com': 'youtube',
  'www.youtube.com': 'youtube',
  'm.youtube.com': 'youtube',
  'music.youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'www.youtu.be': 'youtube',
  'youtube-nocookie.com': 'youtube',
  'www.youtube-nocookie.com': 'youtube',
  'instagram.com': 'instagram',
  'www.instagram.com': 'instagram',
  'm.instagram.com': 'instagram',
  'instagr.am': 'instagram',
  'www.instagr.am': 'instagram',
  'facebook.com': 'facebook',
  'www.facebook.com': 'facebook',
  'm.facebook.com': 'facebook',
  'web.facebook.com': 'facebook',
  'fb.watch': 'facebook',
  'www.fb.watch': 'facebook',
  'fb.com': 'facebook',
  'www.fb.com': 'facebook',
  'x.com': 'x',
  'www.x.com': 'x',
  'mobile.x.com': 'x',
  'twitter.com': 'x',
  'www.twitter.com': 'x',
  'mobile.twitter.com': 'x',
  'dailymotion.com': 'dailymotion',
  'www.dailymotion.com': 'dailymotion',
  'dai.ly': 'dailymotion',
  'www.dai.ly': 'dailymotion',
};

/**
 * Validates and normalizes a media URL against the strict MediaVault platform allowlist.
 *
 * @param {string} rawUrl
 * @returns {{ url: string, platform: string, hostname: string, parsedUrl: URL }}
 */
function validateMediaUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new AppError(400, 'INVALID_URL', 'The provided URL is not supported or invalid.');
  }

  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('-')) {
    throw new AppError(400, 'INVALID_URL', 'The provided URL is not supported or invalid.');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError(400, 'INVALID_URL', 'The provided URL is not supported or invalid.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(400, 'INVALID_URL', 'The provided URL is not supported or invalid.');
  }

  if (parsed.username || parsed.password) {
    throw new AppError(400, 'INVALID_URL', 'URLs containing credentials are not allowed.');
  }

  const hostname = parsed.hostname.toLowerCase();
  const platform = HOST_PLATFORM_MAP[hostname];
  if (!platform) {
    throw new AppError(
      400,
      'INVALID_URL',
      'The provided URL domain is not supported by MediaVault.'
    );
  }

  return {
    url: parsed.toString(),
    platform,
    hostname,
    parsedUrl: parsed,
  };
}

/**
 * Detects playlist-only URLs so yt-dlp runs flat-playlist inspection instead of
 * failing or downloading an entire playlist synchronously.
 *
 * @param {URL} parsedUrl
 * @returns {boolean}
 */
function isPlaylistOnlyUrl(parsedUrl) {
  const pathname = parsedUrl.pathname.toLowerCase();
  if (
    pathname === '/playlist' ||
    pathname.startsWith('/playlist/') ||
    pathname.includes('/playlist/')
  ) {
    return true;
  }
  return parsedUrl.searchParams.has('list') && !parsedUrl.searchParams.has('v');
}

/**
 * Resolves and verifies the Netscape cookie file path for a validated platform.
 *
 * @param {string} platform
 * @returns {Promise<string>}
 */
async function resolveCookieFile(platform) {
  if (!ALLOWED_PLATFORMS.includes(platform)) {
    throw new AppError(400, 'INVALID_URL', 'Unsupported platform for cookie lookup.');
  }

  const cookiesDir = process.env.COOKIES_DIR || '/data/cookies';
  const cookiePath = path.join(cookiesDir, `${platform}.txt`);

  try {
    await fs.promises.access(cookiePath, fs.constants.R_OK);
  } catch {
    throw new AppError(
      400,
      'COOKIE_NOT_FOUND',
      `No cookies file uploaded for platform "${platform}".`
    );
  }

  return cookiePath;
}

/**
 * Copies a platform's cookie file into a per-invocation 0600 temp file so yt-dlp's
 * cookie jar write-back on exit works cleanly even when `/data/cookies` is read-only.
 *
 * @param {string} platform
 * @returns {Promise<{ cookiePath: string, cleanup: () => Promise<void> }>}
 */
async function prepareCookieArg(platform) {
  const sourcePath = await resolveCookieFile(platform);
  const content = await fs.promises.readFile(sourcePath, 'utf8');
  const tempPath = path.join(
    os.tmpdir(),
    `mediavault-cookies-${platform}-${crypto.randomUUID()}.txt`
  );

  await fs.promises.writeFile(tempPath, content, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.promises.chmod(tempPath, 0o600);

  return {
    cookiePath: tempPath,
    cleanup: async () => {
      await fs.promises.unlink(tempPath).catch(() => {});
    },
  };
}

function extractYtDlpErrorMessage(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /^ERROR:/i.test(line));
  if (errorLine) {
    return errorLine.replace(/^ERROR:\s*/i, '');
  }
  return lines[lines.length - 1] || 'yt-dlp failed to process the requested media URL.';
}

/**
 * Safe subprocess wrapper around `yt-dlp` using `child_process.spawn` (`shell: false`).
 * Always enforces `--js-runtimes node`.
 *
 * @param {string[]} args
 * @param {{ timeoutMs?: number, maxStdoutBytes?: number }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function spawnYtDlp(args, { timeoutMs = 90000, maxStdoutBytes = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const finalArgs = args.includes('--js-runtimes')
      ? [...args]
      : ['--js-runtimes', 'node', ...args];

    const child = spawn('yt-dlp', finalArgs, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrText = '';
    let settled = false;
    let timedOut = false;
    let forceKillTimer = null;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (err) reject(err);
      else resolve(result);
    };

    const killChild = () => {
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 3000);
      forceKillTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
      finish(new AppError(504, 'EXTRACTOR_TIMEOUT', 'Media inspection timed out.'));
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        killChild();
        finish(
          new AppError(
            422,
            'EXTRACTOR_ERROR',
            'Extractor metadata response exceeded maximum allowed size.'
          )
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      if (stderrText.length < 256 * 1024) {
        stderrText += chunk.toString('utf8');
      }
    });

    child.on('error', (err) => {
      finish(
        new AppError(
          500,
          'EXTRACTOR_ERROR',
          `Failed to start yt-dlp subprocess: ${err.message}`
        )
      );
    });

    child.on('close', (code) => {
      if (timedOut || settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      if (code !== 0) {
        finish(
          new AppError(422, 'EXTRACTOR_ERROR', extractYtDlpErrorMessage(stderrText))
        );
        return;
      }
      finish(null, { stdout, stderr: stderrText });
    });
  });
}

/**
 * Builds yt-dlp inspection CLI arguments. In playlist mode, `--playlist-end` is omitted
 * unless a positive `maxPlaylistItems` cap is configured (0 = unlimited).
 *
 * @param {{ playlistMode: boolean, maxPlaylistItems?: number, forceIpv4?: boolean, cookiePath?: string | null, url: string }} params
 * @returns {string[]}
 */
function buildInspectArgs({
  playlistMode,
  maxPlaylistItems = 0,
  forceIpv4 = true,
  cookiePath = null,
  url,
}) {
  const args = playlistMode
    ? ['--flat-playlist', '--dump-single-json', '--no-warnings']
    : ['--no-playlist', '--dump-single-json', '--no-warnings'];

  if (playlistMode && Number.isFinite(maxPlaylistItems) && maxPlaylistItems > 0) {
    args.push('--playlist-end', String(Math.floor(maxPlaylistItems)));
  }

  if (forceIpv4) {
    args.push('--force-ipv4');
  }

  if (cookiePath) {
    args.push('--cookies', cookiePath);
  }

  args.push('--', url);
  return args;
}

/**
 * Inspects a media URL via yt-dlp JSON dump after strict domain allowlisting and SSRF checks.
 *
 * @param {string} rawUrl
 * @param {{ useCookies?: boolean, includePlaylist?: boolean }} [options]
 */
async function inspectMediaUrl(rawUrl, { useCookies = false, includePlaylist = false } = {}) {
  const validated = validateMediaUrl(rawUrl);
  await assertPublicUrl(validated.url);

  const playlistMode =
    includePlaylist === true
      ? isPlaylistOnlyUrl(validated.parsedUrl) || validated.parsedUrl.searchParams.has('list')
      : isPlaylistOnlyUrl(validated.parsedUrl);

  const rawMax = Number(process.env.MAX_PLAYLIST_ITEMS || 0);
  const maxPlaylistItems = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 0;

  let cookieHandle = null;
  try {
    if (useCookies === true) {
      cookieHandle = await prepareCookieArg(validated.platform);
    }

    const args = buildInspectArgs({
      playlistMode,
      maxPlaylistItems,
      forceIpv4: process.env.YTDLP_FORCE_IPV4 !== 'false',
      cookiePath: cookieHandle ? cookieHandle.cookiePath : null,
      url: validated.url,
    });

    const { stdout } = await spawnYtDlp(args, {
      timeoutMs: playlistMode ? 180000 : 90000,
      maxStdoutBytes: playlistMode ? 64 * 1024 * 1024 : 20 * 1024 * 1024,
    });

    let rawData;
    try {
      rawData = JSON.parse(stdout);
    } catch {
      throw new AppError(
        422,
        'EXTRACTOR_ERROR',
        'Failed to parse metadata returned by yt-dlp.'
      );
    }

    return {
      platform: validated.platform,
      url: validated.url,
      rawData,
    };
  } finally {
    if (cookieHandle) {
      await cookieHandle.cleanup();
    }
  }
}

module.exports = {
  ALLOWED_PLATFORMS,
  HOST_PLATFORM_MAP,
  validateMediaUrl,
  isPlaylistOnlyUrl,
  resolveCookieFile,
  prepareCookieArg,
  spawnYtDlp,
  buildInspectArgs,
  inspectMediaUrl,
};
