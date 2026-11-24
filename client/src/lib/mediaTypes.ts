export type MediaMode = 'video' | 'audio';
export type MediaContainer = 'mp4' | 'webm' | 'mkv' | 'mp3';
export type DeliveryType = 'direct' | 'worker';
export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'muxing'
  | 'ready'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface InspectFormat {
  formatId: string;
  formatSelector: string;
  label: string;
  container: MediaContainer;
  mode: MediaMode;
  delivery: DeliveryType;
  isDirect: boolean;
  height: number | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  filesize: number | null;
  directUrl?: string;
  proxyUrl?: string;
}

export interface SingleInspectResult {
  isPlaylist: false;
  title: string;
  thumbnail: string | null;
  duration: number;
  platform: string;
  formats: InspectFormat[];
}

export interface PlaylistItem {
  id: string;
  title: string;
  creator: string | null;
  duration: number;
  thumbnail: string | null;
  url: string;
}

export interface PlaylistInspectResult {
  isPlaylist: true;
  platform: string;
  playlistTitle: string;
  playlistUrl: string;
  totalItems: number;
  items: PlaylistItem[];
}

export type InspectResult = SingleInspectResult | PlaylistInspectResult;

export interface JobSummary {
  id: string;
  batchId: string | null;
  sourceUrl?: string;
  title: string;
  thumbnailUrl?: string | null;
  duration?: number;
  platform: string;
  container: MediaContainer;
  mode: MediaMode;
  formatSelector?: string;
  useCookies?: boolean;
  status: JobStatus;
  progress: number;
  downloadSpeed?: string | null;
  eta?: string | null;
  errorMessage?: string | null;
  fileName: string | null;
  fileSizeBytes: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface JobDetail extends JobSummary {
  downloadSpeed: string | null;
  eta: string | null;
  errorMessage: string | null;
}

export type CookiePlatform = 'youtube' | 'instagram' | 'facebook' | 'x' | 'dailymotion';

export interface CookiePlatformStatus {
  platform: CookiePlatform;
  installed: boolean;
  isValid: boolean | null;
  updatedAt: string | null;
}

export interface SystemStatusInfo {
  ytDlpVersion: string;
  ffmpegInstalled: boolean;
  tempStorageBytes: number;
  tempDiskFreeBytes: number;
  downloadTtlMinutes: number;
  workerConcurrency: number;
  allowRegistration: boolean;
  activeJobsCount: number;
  queuedJobsCount: number;
  dbConnected: boolean;
}

export interface RecentInspectionItem {
  url: string;
  title: string;
  platform: string;
  isPlaylist: boolean;
  inspectedAt: string;
}

export interface PlaylistFormatPreset {
  id: string;
  label: string;
  shortBadge: string;
  mode: MediaMode;
  container: MediaContainer;
  formatSelector: string;
}

export const MAX_BATCH_ITEMS = 50;

export const SUPPORTED_PLATFORMS = [
  { id: 'youtube', label: 'YouTube', shortLabel: 'YT' },
  { id: 'yt-music', label: 'YT Music', shortLabel: 'YTM' },
  { id: 'instagram', label: 'Instagram', shortLabel: 'IG' },
  { id: 'x', label: 'X', shortLabel: 'X' },
  { id: 'facebook', label: 'Facebook', shortLabel: 'FB' },
  { id: 'dailymotion', label: 'Dailymotion', shortLabel: 'DM' },
] as const;

export const PLAYLIST_FORMAT_PRESETS: readonly PlaylistFormatPreset[] = [
  {
    id: 'mp3-320',
    label: 'Audio · MP3 (320 kbps)',
    shortBadge: '320k MP3',
    mode: 'audio',
    container: 'mp3',
    formatSelector: 'bestaudio/best',
  },
  {
    id: 'mp4-1080',
    label: 'Video · Best MP4 ≤ 1080p (H.264)',
    shortBadge: '1080p MP4',
    mode: 'video',
    container: 'mp4',
    formatSelector:
      'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=1080][ext=mp4]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  },
  {
    id: 'webm-1080',
    label: 'Video · Best WebM ≤ 1080p (VP9)',
    shortBadge: '1080p WebM',
    mode: 'video',
    container: 'webm',
    formatSelector:
      'bestvideo[height<=1080][vcodec^=vp9]+bestaudio[acodec^=opus]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  },
  {
    id: 'mkv-1080',
    label: 'Video · Best MKV ≤ 1080p (Stream-Copy)',
    shortBadge: '1080p MKV',
    mode: 'video',
    container: 'mkv',
    formatSelector: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  },
] as const;

export const ACTIVE_JOB_STATUSES = new Set<JobStatus>([
  'queued',
  'downloading',
  'muxing',
]);

const RECENT_STORAGE_KEY = 'mediavault:recent-inspections';
const MAX_RECENT_ITEMS = 3;

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatTotalDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (safe === 0) return 'Duration unknown';
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;

  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return 'Est. auto';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const decimals = unitIdx >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unitIdx]}`;
}

export function formatPlatformLabel(platform: string, sourceUrl?: string): string {
  const normalized = String(platform || '').toLowerCase();
  if (normalized === 'youtube') {
    if (sourceUrl && /music\.youtube\.com/i.test(sourceUrl)) {
      return 'YT Music';
    }
    return 'YouTube';
  }
  if (normalized === 'instagram') return 'Instagram';
  if (normalized === 'facebook') return 'Facebook';
  if (normalized === 'x') return 'X';
  if (normalized === 'dailymotion') return 'Dailymotion';
  return normalized ? normalized.toUpperCase() : 'Unknown';
}

export async function extractApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as {
      error?: { message?: string };
      message?: string;
    };
    return payload.error?.message || payload.message || fallback;
  } catch {
    return fallback;
  }
}

export async function extractApiErrorInfo(
  res: Response,
  fallback: string
): Promise<{ code: string | null; message: string }> {
  try {
    const payload = (await res.json()) as {
      error?: { code?: string; message?: string };
      message?: string;
    };
    return {
      code: payload.error?.code || null,
      message: payload.error?.message || payload.message || fallback,
    };
  } catch {
    return { code: null, message: fallback };
  }
}

export function formatRelativeTime(isoDate: string | null | undefined): string {
  if (!isoDate) return 'Never updated';
  const parsed = Date.parse(isoDate);
  if (!Number.isFinite(parsed)) return 'Recently updated';

  const diffSeconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (diffSeconds < 60) return 'Updated just now';
  const mins = Math.floor(diffSeconds / 60);
  if (mins < 60) return `Updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatExpiryCountdown(
  expiresAt: string | null | undefined,
  nowMs: number
): string {
  if (!expiresAt) return 'TTL active';
  const targetMs = Date.parse(expiresAt);
  if (!Number.isFinite(targetMs)) return 'TTL active';

  const remainingSeconds = Math.floor((targetMs - nowMs) / 1000);
  if (remainingSeconds <= 0) return 'Expired';
  if (remainingSeconds < 60) return 'Expires in <1m';
  const remainingMinutes = Math.ceil(remainingSeconds / 60);
  if (remainingMinutes < 60) return `Expires in ${remainingMinutes}m`;
  const hrs = Math.floor(remainingMinutes / 60);
  const mins = remainingMinutes % 60;
  return mins > 0 ? `Expires in ${hrs}h ${mins}m` : `Expires in ${hrs}h`;
}

export function loadRecentInspections(): RecentInspectionItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentInspectionItem =>
          Boolean(item) &&
          typeof item.url === 'string' &&
          typeof item.title === 'string' &&
          typeof item.platform === 'string'
      )
      .slice(0, MAX_RECENT_ITEMS);
  } catch {
    return [];
  }
}

export function saveRecentInspection(entry: RecentInspectionItem): RecentInspectionItem[] {
  const existing = loadRecentInspections().filter((item) => item.url !== entry.url);
  const next = [entry, ...existing].slice(0, MAX_RECENT_ITEMS);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage quota / private mode failures
    }
  }
  return next;
}

export function clearRecentInspections(): RecentInspectionItem[] {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(RECENT_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
  return [];
}
