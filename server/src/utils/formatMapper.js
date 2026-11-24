const MAX_VIDEO_HEIGHT = 1080;

const CONTAINER_PRIORITY = {
  mp4: 0,
  webm: 1,
  mkv: 2,
  mp3: 3,
};

const SAFE_UPSTREAM_HEADER_MAP = {
  'user-agent': 'User-Agent',
  referer: 'Referer',
  cookie: 'Cookie',
  accept: 'Accept',
  'accept-language': 'Accept-Language',
};

/**
 * Sanitizes a media title into a safe attachment filename.
 *
 * @param {string} title
 * @param {string} [ext]
 * @returns {string}
 */
function sanitizeFilename(title, ext) {
  const base =
    String(title || '')
      .replace(/[\/\\]/g, ' ')
      .replace(/[^a-zA-Z0-9_\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/^[_-]+|[_-]+$/g, '')
      .slice(0, 100)
      .replace(/^[_-]+|[_-]+$/g, '') || 'media_file';

  const cleanExt = String(ext || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();

  return cleanExt ? `${base}.${cleanExt}` : base;
}

/**
 * Classifies yt-dlp `vcodec` identifiers into normalized codec families.
 *
 * @param {string | null | undefined} vcodec
 * @returns {string | null}
 */
function classifyVideoCodec(vcodec) {
  if (!vcodec || vcodec === 'none') return null;
  const v = String(vcodec).trim().toLowerCase();
  if (/^(avc1|h264|avc)/.test(v)) return 'h264';
  if (/^vp0?9/.test(v)) return 'vp9';
  if (/^av0?1/.test(v)) return 'av1';
  if (/^(hev1|hvc1|hevc|h265)/.test(v)) return 'hevc';
  return v.split('.')[0] || null;
}

/**
 * Classifies yt-dlp `acodec` identifiers into normalized codec families.
 *
 * @param {string | null | undefined} acodec
 * @returns {string | null}
 */
function classifyAudioCodec(acodec) {
  if (!acodec || acodec === 'none') return null;
  const a = String(acodec).trim().toLowerCase();
  if (/^(mp4a|aac)/.test(a)) return 'aac';
  if (/^opus/.test(a)) return 'opus';
  if (/^vorbis/.test(a)) return 'vorbis';
  if (/^mp3/.test(a)) return 'mp3';
  return a.split('.')[0] || null;
}

function isProgressiveHttp(format) {
  if (typeof format?.url !== 'string' || !/^https?:\/\//i.test(format.url)) {
    return false;
  }

  if (format.protocol) {
    const proto = String(format.protocol).toLowerCase();
    if (proto !== 'https' && proto !== 'http') {
      return false;
    }
  }

  try {
    const pathname = new URL(format.url).pathname.toLowerCase();
    if (pathname.endsWith('.m3u8')) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

function extractSafeHeaders(format, rawData) {
  const result = {};
  const source =
    (format && format.http_headers && typeof format.http_headers === 'object'
      ? format.http_headers
      : null) ||
    (rawData && rawData.http_headers && typeof rawData.http_headers === 'object'
      ? rawData.http_headers
      : null);

  if (source) {
    for (const [key, value] of Object.entries(source)) {
      const canonical = SAFE_UPSTREAM_HEADER_MAP[key.toLowerCase()];
      if (canonical && typeof value === 'string' && value.length > 0) {
        result[canonical] = value;
      }
    }
  }

  if (!result.Cookie) {
    const fallbackCookies = format?.cookies || rawData?.cookies;
    if (typeof fallbackCookies === 'string' && fallbackCookies.length > 0) {
      result.Cookie = fallbackCookies;
    }
  }

  return result;
}

function pickBestAudio(audioStreams, targetCodec = null) {
  const filtered = targetCodec
    ? audioStreams.filter((a) => classifyAudioCodec(a.acodec) === targetCodec)
    : audioStreams;

  if (filtered.length === 0) return null;

  return [...filtered].sort((a, b) => {
    const aHttps = isProgressiveHttp(a) ? 1 : 0;
    const bHttps = isProgressiveHttp(b) ? 1 : 0;
    if (aHttps !== bHttps) return bHttps - aHttps;

    const aDrc = String(a.format_id || '').endsWith('-drc') ? 1 : 0;
    const bDrc = String(b.format_id || '').endsWith('-drc') ? 1 : 0;
    if (aDrc !== bDrc) return aDrc - bDrc;

    const aBitrate = Number(a.abr || a.tbr || 0);
    const bBitrate = Number(b.abr || b.tbr || 0);
    return bBitrate - aBitrate;
  })[0];
}

function scoreVideoCandidate(f) {
  return {
    https: isProgressiveHttp(f) ? 1 : 0,
    fps: Number(f.fps || 0),
    tbr: Number(f.tbr || 0),
  };
}

function isBetterVideoCandidate(candidate, current) {
  if (!current) return true;
  const a = scoreVideoCandidate(candidate);
  const b = scoreVideoCandidate(current);
  if (a.https !== b.https) return a.https > b.https;
  if (a.fps !== b.fps) return a.fps > b.fps;
  return a.tbr > b.tbr;
}

function resolvePlaylistEntryUrl(entry, platform) {
  if (typeof entry.webpage_url === 'string' && /^https?:\/\//i.test(entry.webpage_url)) {
    return entry.webpage_url;
  }
  if (typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url)) {
    return entry.url;
  }
  if (platform === 'youtube' && entry.id) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(entry.id)}`;
  }
  return entry.url || null;
}

const UNAVAILABLE_TITLES = new Set(['[deleted video]', '[private video]']);

function normalizePlaylist(rawData, { platform, sourceUrl }) {
  const items = (rawData.entries || [])
    .filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const titleLower = String(entry.title || '').trim().toLowerCase();
      if (UNAVAILABLE_TITLES.has(titleLower)) return false;
      if (entry.availability === 'unavailable') return false;
      return true;
    })
    .map((entry, idx) => {
      const thumbnail =
        entry.thumbnail ||
        (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0
          ? entry.thumbnails[entry.thumbnails.length - 1].url
          : null);
      const id = String(entry.id || idx + 1);
      const fallbackThumb =
        platform === 'youtube' && entry.id
          ? `https://i.ytimg.com/vi/${encodeURIComponent(entry.id)}/hqdefault.jpg`
          : null;

      return {
        id,
        title: entry.title || 'Untitled Media',
        creator:
          entry.uploader ||
          entry.channel ||
          entry.creator ||
          entry.artist ||
          rawData.uploader ||
          rawData.channel ||
          null,
        duration: Number(entry.duration || 0),
        thumbnail: thumbnail || fallbackThumb,
        url: resolvePlaylistEntryUrl(entry, platform),
      };
    })
    .filter((item) => Boolean(item.url));

  return {
    isPlaylist: true,
    platform,
    playlistTitle: rawData.title || 'Playlist',
    playlistUrl: rawData.webpage_url || sourceUrl,
    totalItems: items.length,
    items,
  };
}

/**
 * Normalizes yt-dlp metadata, caps video resolutions at 1080p, tags progressive
 * HTTP streams as `delivery: "direct"`, and maps separate video+audio streams to
 * stream-copy compatible containers (`mp4`, `webm`, `mkv`) plus an `mp3` option.
 *
 * @param {Record<string, any>} rawData
 * @param {{ platform: string, sourceUrl: string }} context
 */
function mapInspectResponse(rawData, { platform, sourceUrl }) {
  if (rawData && rawData._type === 'playlist' && Array.isArray(rawData.entries)) {
    return normalizePlaylist(rawData, { platform, sourceUrl });
  }

  const rawFormats =
    Array.isArray(rawData?.formats) && rawData.formats.length > 0
      ? rawData.formats
      : rawData?.url
        ? [rawData]
        : [];

  const directBest = new Map();
  const workerBest = new Map();
  const audioOnlyStreams = [];
  const videoOnlyBestByHeightCodec = new Map();

  for (const f of rawFormats) {
    if (!f || typeof f !== 'object') continue;

    // Discard storyboard and image-only entries.
    if (
      f.ext === 'mhtml' ||
      f.vcodec === 'images' ||
      String(f.format_note || '').toLowerCase().includes('storyboard')
    ) {
      continue;
    }

    const numericHeight =
      typeof f.height === 'number' && Number.isFinite(f.height) && f.height > 0
        ? f.height
        : null;

    // Strictly enforce <= 1080p video cap.
    if (numericHeight !== null && numericHeight > MAX_VIDEO_HEIGHT) {
      continue;
    }

    const fallbackCombined =
      !f.vcodec &&
      !f.acodec &&
      ['mp4', 'webm'].includes(String(f.ext || '').toLowerCase()) &&
      Boolean(numericHeight || isProgressiveHttp(f));

    const hasVideo = (Boolean(f.vcodec) && f.vcodec !== 'none') || fallbackCombined;
    const hasAudio = (Boolean(f.acodec) && f.acodec !== 'none') || fallbackCombined;

    if (hasVideo && hasAudio) {
      const rawExt = String(f.ext || '').toLowerCase();
      const vcodec = classifyVideoCodec(f.vcodec);
      const acodec = classifyAudioCodec(f.acodec);

      if (isProgressiveHttp(f)) {
        const container = ['mp4', 'webm'].includes(rawExt) ? rawExt : 'mp4';
        const dedupeKey = `${numericHeight || 0}:${container}`;
        const existing = directBest.get(dedupeKey);
        if (!existing || Number(f.tbr || 0) > Number(existing._tbr || 0)) {
          directBest.set(dedupeKey, {
            formatId: String(f.format_id || 'direct'),
            formatSelector: String(f.format_id || 'best[height<=1080]'),
            label: `${numericHeight ? `${numericHeight}p ` : ''}${container.toUpperCase()} (Direct Stream)`,
            container,
            mode: 'video',
            delivery: 'direct',
            isDirect: true,
            height: numericHeight,
            fps: f.fps ? Number(f.fps) : null,
            vcodec,
            acodec,
            filesize: f.filesize || f.filesize_approx || null,
            directUrl: f.url,
            _httpHeaders: extractSafeHeaders(f, rawData),
            _tbr: Number(f.tbr || 0),
          });
        }
      } else {
        const container = ['mp4', 'webm', 'mkv'].includes(rawExt) ? rawExt : 'mp4';
        const dedupeKey = `${numericHeight || 0}:${container}:${vcodec || 'auto'}`;
        const existing = workerBest.get(dedupeKey);
        if (!existing || isBetterVideoCandidate(f, existing._raw)) {
          workerBest.set(dedupeKey, {
            formatId: String(f.format_id),
            formatSelector: String(f.format_id),
            label: `${numericHeight ? `${numericHeight}p${numericHeight >= 720 ? ' HD' : ''} ` : ''}(${container.toUpperCase()} Stream-Copy)`,
            container,
            mode: 'video',
            delivery: 'worker',
            isDirect: false,
            height: numericHeight,
            fps: f.fps ? Number(f.fps) : null,
            vcodec,
            acodec,
            filesize: f.filesize || f.filesize_approx || null,
            _raw: f,
          });
        }
      }
      continue;
    }

    if (hasAudio && !hasVideo) {
      audioOnlyStreams.push(f);
      continue;
    }

    if (hasVideo && !hasAudio && numericHeight !== null) {
      const vFamily = classifyVideoCodec(f.vcodec) || 'unknown';
      const key = `${numericHeight}:${vFamily}`;
      const existing = videoOnlyBestByHeightCodec.get(key);
      if (isBetterVideoCandidate(f, existing)) {
        videoOnlyBestByHeightCodec.set(key, f);
      }
    }
  }

  const bestAac = pickBestAudio(audioOnlyStreams, 'aac');
  const bestOpus = pickBestAudio(audioOnlyStreams, 'opus');
  const bestAnyAudio = pickBestAudio(audioOnlyStreams, null);

  for (const v of videoOnlyBestByHeightCodec.values()) {
    const vFamily = classifyVideoCodec(v.vcodec);
    const height = Number(v.height);
    const hdTag = height >= 720 ? ' HD' : '';

    let container;
    let audio;
    let label;

    if (vFamily === 'h264' && bestAac) {
      container = 'mp4';
      audio = bestAac;
      label = `${height}p${hdTag} (MP4 Stream-Copy)`;
    } else if ((vFamily === 'vp9' || vFamily === 'av1') && bestOpus) {
      container = 'webm';
      audio = bestOpus;
      label = `${height}p${hdTag} (WebM ${vFamily.toUpperCase()})`;
    } else if (bestAnyAudio) {
      container = 'mkv';
      audio = bestAnyAudio;
      label = `${height}p${hdTag} (MKV Stream-Copy Fallback)`;
    } else {
      continue;
    }

    const vSize = Number(v.filesize || v.filesize_approx || 0);
    const aSize = Number(audio.filesize || audio.filesize_approx || 0);
    const dedupeKey = `${height}:${container}:${vFamily || 'unknown'}`;
    const existing = workerBest.get(dedupeKey);

    if (!existing || isBetterVideoCandidate(v, existing._raw)) {
      workerBest.set(dedupeKey, {
        formatId: `${v.format_id}+${audio.format_id}`,
        formatSelector: `${v.format_id}+${audio.format_id}`,
        label,
        container,
        mode: 'video',
        delivery: 'worker',
        isDirect: false,
        height,
        fps: v.fps ? Number(v.fps) : null,
        vcodec: vFamily,
        acodec: classifyAudioCodec(audio.acodec),
        filesize: vSize > 0 && aSize > 0 ? vSize + aSize : null,
        _raw: v,
      });
    }
  }

  const videoFormats = [
    ...Array.from(directBest.values()).map(({ _tbr, ...fmt }) => fmt),
    ...Array.from(workerBest.values()).map(({ _raw, ...fmt }) => fmt),
  ].sort((a, b) => {
    const hDiff = Number(b.height || 0) - Number(a.height || 0);
    if (hDiff !== 0) return hDiff;
    if (a.delivery !== b.delivery) return a.delivery === 'direct' ? -1 : 1;
    const cDiff =
      (CONTAINER_PRIORITY[a.container] ?? 99) - (CONTAINER_PRIORITY[b.container] ?? 99);
    if (cDiff !== 0) return cDiff;
    if (a.vcodec !== b.vcodec) {
      if (a.vcodec === 'vp9') return -1;
      if (b.vcodec === 'vp9') return 1;
    }
    return 0;
  });

  const hasAudioSource = audioOnlyStreams.length > 0 || directBest.size > 0 || workerBest.size > 0;
  const formats = [...videoFormats];
  if (hasAudioSource) {
    formats.push({
      formatId: 'bestaudio',
      formatSelector: 'bestaudio/best',
      label: 'MP3 Audio (High Quality 320kbps)',
      container: 'mp3',
      mode: 'audio',
      delivery: 'worker',
      isDirect: false,
      height: null,
      fps: null,
      vcodec: null,
      acodec: 'mp3',
      filesize: null,
    });
  }

  return {
    isPlaylist: false,
    title: rawData?.title || 'Media File',
    thumbnail: rawData?.thumbnail || null,
    duration: Number(rawData?.duration || 0),
    platform,
    formats,
  };
}

module.exports = {
  MAX_VIDEO_HEIGHT,
  sanitizeFilename,
  classifyVideoCodec,
  classifyAudioCodec,
  isProgressiveHttp,
  mapInspectResponse,
};
