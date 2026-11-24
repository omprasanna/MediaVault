'use client';

import { useCallback } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  extractApiErrorInfo,
  type InspectResult,
  type MediaMode,
} from '@/lib/mediaTypes';

export type JobFilterStatus = 'all' | 'active' | 'paused' | 'ready' | 'failed';

export const DOWNLOADER_STATE_KEY = 'mediavault:downloader-state';
export const QUEUE_UI_STATE_KEY = 'mediavault:queue-ui-state';

const DOWNLOADER_DRAFT_STORAGE_KEY = 'mediavault:swr:downloader-draft:v1';
const DOWNLOADER_INSPECT_STORAGE_KEY = 'mediavault:swr:downloader-inspect:v1';
const QUEUE_UI_STORAGE_KEY = 'mediavault:swr:queue-ui:v1';
const MAX_INSPECT_CACHE_CHARS = 2_000_000;

const VALID_QUEUE_FILTERS = new Set<JobFilterStatus>([
  'all',
  'active',
  'paused',
  'ready',
  'failed',
]);

export interface DownloaderState {
  url: string;
  useCookies: boolean;
  singleItemOnly: boolean;
  inspectResult: InspectResult | null;
  inspectedUrl: string;
  inspectLatencyMs: number | null;
  trackedJobIds: string[];
  playlistPresetId: string | null;
  playlistSelectedIds: string[] | null;
  singleMode: MediaMode | null;
  singleFormatId: string | null;
}

export interface QueueUiState {
  filter: JobFilterStatus;
  page: number;
}

export const DEFAULT_DOWNLOADER_STATE: DownloaderState = {
  url: '',
  useCookies: false,
  singleItemOnly: false,
  inspectResult: null,
  inspectedUrl: '',
  inspectLatencyMs: null,
  trackedJobIds: [],
  playlistPresetId: null,
  playlistSelectedIds: null,
  singleMode: null,
  singleFormatId: null,
};

export const DEFAULT_QUEUE_UI_STATE: QueueUiState = {
  filter: 'all',
  page: 1,
};

type SwrConfigReturn = ReturnType<typeof useSWRConfig>;
type SwrMutateFn = SwrConfigReturn['mutate'];
type SwrCacheObj = SwrConfigReturn['cache'];

export class SwrHttpError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'SwrHttpError';
    this.status = status;
    this.code = code;
  }
}

export async function swrJsonFetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const info = await extractApiErrorInfo(
      res,
      `Request failed with status ${res.status}.`
    );
    throw new SwrHttpError(info.message, res.status, info.code);
  }
  return (await res.json()) as T;
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readPersistedDownloaderState(): DownloaderState | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }

  try {
    const rawDraft = storage.getItem(DOWNLOADER_DRAFT_STORAGE_KEY);
    const rawInspect = storage.getItem(DOWNLOADER_INSPECT_STORAGE_KEY);
    if (!rawDraft && !rawInspect) {
      return null;
    }

    const next: DownloaderState = { ...DEFAULT_DOWNLOADER_STATE };

    if (rawDraft) {
      const parsedDraft = JSON.parse(rawDraft) as Partial<DownloaderState> | null;
      if (parsedDraft && typeof parsedDraft === 'object') {
        if (typeof parsedDraft.url === 'string') next.url = parsedDraft.url;
        if (typeof parsedDraft.useCookies === 'boolean') next.useCookies = parsedDraft.useCookies;
        if (typeof parsedDraft.singleItemOnly === 'boolean') {
          next.singleItemOnly = parsedDraft.singleItemOnly;
        }
        if (typeof parsedDraft.inspectedUrl === 'string') {
          next.inspectedUrl = parsedDraft.inspectedUrl;
        }
        if (
          typeof parsedDraft.inspectLatencyMs === 'number' &&
          Number.isFinite(parsedDraft.inspectLatencyMs)
        ) {
          next.inspectLatencyMs = parsedDraft.inspectLatencyMs;
        }
        if (Array.isArray(parsedDraft.trackedJobIds)) {
          next.trackedJobIds = parsedDraft.trackedJobIds.filter(
            (id): id is string => typeof id === 'string'
          );
        }
        if (typeof parsedDraft.playlistPresetId === 'string') {
          next.playlistPresetId = parsedDraft.playlistPresetId;
        }
        if (Array.isArray(parsedDraft.playlistSelectedIds)) {
          next.playlistSelectedIds = parsedDraft.playlistSelectedIds.filter(
            (id): id is string => typeof id === 'string'
          );
        }
        if (parsedDraft.singleMode === 'video' || parsedDraft.singleMode === 'audio') {
          next.singleMode = parsedDraft.singleMode;
        }
        if (typeof parsedDraft.singleFormatId === 'string') {
          next.singleFormatId = parsedDraft.singleFormatId;
        }
      }
    }

    if (rawInspect) {
      const parsedInspect = JSON.parse(rawInspect) as Partial<InspectResult> | null;
      if (parsedInspect && typeof parsedInspect.isPlaylist === 'boolean') {
        next.inspectResult = parsedInspect as InspectResult;
      }
    }

    return next;
  } catch {
    return null;
  }
}

export function writePersistedDownloaderState(
  next: DownloaderState,
  prevInspectResult?: InspectResult | null
): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    const draftPayload = {
      url: next.url,
      useCookies: next.useCookies,
      singleItemOnly: next.singleItemOnly,
      inspectedUrl: next.inspectedUrl,
      inspectLatencyMs: next.inspectLatencyMs,
      trackedJobIds: next.trackedJobIds,
      playlistPresetId: next.playlistPresetId,
      playlistSelectedIds: next.playlistSelectedIds,
      singleMode: next.singleMode,
      singleFormatId: next.singleFormatId,
    };
    storage.setItem(DOWNLOADER_DRAFT_STORAGE_KEY, JSON.stringify(draftPayload));
  } catch {
    // Ignore quota or storage restriction failures
  }

  if (next.inspectResult !== prevInspectResult) {
    try {
      if (!next.inspectResult) {
        storage.removeItem(DOWNLOADER_INSPECT_STORAGE_KEY);
      } else {
        const serialized = JSON.stringify(next.inspectResult);
        if (serialized.length <= MAX_INSPECT_CACHE_CHARS) {
          storage.setItem(DOWNLOADER_INSPECT_STORAGE_KEY, serialized);
        } else {
          storage.removeItem(DOWNLOADER_INSPECT_STORAGE_KEY);
        }
      }
    } catch {
      try {
        storage.removeItem(DOWNLOADER_INSPECT_STORAGE_KEY);
      } catch {
        // Ignore
      }
    }
  }
}

export function readPersistedQueueUiState(): QueueUiState | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(QUEUE_UI_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<QueueUiState> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const filter =
      parsed.filter && VALID_QUEUE_FILTERS.has(parsed.filter)
        ? parsed.filter
        : DEFAULT_QUEUE_UI_STATE.filter;
    const page =
      typeof parsed.page === 'number' && Number.isFinite(parsed.page) && parsed.page >= 1
        ? Math.floor(parsed.page)
        : DEFAULT_QUEUE_UI_STATE.page;

    return { filter, page };
  } catch {
    return null;
  }
}

export function writePersistedQueueUiState(next: QueueUiState): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(QUEUE_UI_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota / private mode failures
  }
}

export function clearPersistedSwrSession(): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(DOWNLOADER_DRAFT_STORAGE_KEY);
    storage.removeItem(DOWNLOADER_INSPECT_STORAGE_KEY);
    storage.removeItem(QUEUE_UI_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup errors
  }
}

export function useDownloaderState() {
  const { cache } = useSWRConfig();
  const { data, mutate } = useSWR<DownloaderState>(DOWNLOADER_STATE_KEY, null, {
    fallbackData: DEFAULT_DOWNLOADER_STATE,
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const state = data ?? DEFAULT_DOWNLOADER_STATE;

  const updateState = useCallback(
    (
      updater:
        | Partial<DownloaderState>
        | ((prev: DownloaderState) => DownloaderState)
    ) => {
      const cachedEntry = cache.get(DOWNLOADER_STATE_KEY) as
        | { data?: DownloaderState }
        | undefined;
      const prev = cachedEntry?.data ?? DEFAULT_DOWNLOADER_STATE;
      const next =
        typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };

      void mutate(next, { revalidate: false });
      writePersistedDownloaderState(next, prev.inspectResult);
    },
    [cache, mutate]
  );

  const resetState = useCallback(() => {
    updateState((prev) => ({
      ...prev,
      url: '',
      inspectResult: null,
      inspectedUrl: '',
      inspectLatencyMs: null,
      playlistPresetId: null,
      playlistSelectedIds: null,
      singleMode: null,
      singleFormatId: null,
    }));
  }, [updateState]);

  return { state, updateState, resetState };
}

export function useQueueUiState() {
  const { cache } = useSWRConfig();
  const { data, mutate } = useSWR<QueueUiState>(QUEUE_UI_STATE_KEY, null, {
    fallbackData: DEFAULT_QUEUE_UI_STATE,
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const uiState = data ?? DEFAULT_QUEUE_UI_STATE;

  const updateUiState = useCallback(
    (updater: Partial<QueueUiState> | ((prev: QueueUiState) => QueueUiState)) => {
      const cachedEntry = cache.get(QUEUE_UI_STATE_KEY) as
        | { data?: QueueUiState }
        | undefined;
      const prev = cachedEntry?.data ?? DEFAULT_QUEUE_UI_STATE;
      const next =
        typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };

      void mutate(next, { revalidate: false });
      writePersistedQueueUiState(next);
    },
    [cache, mutate]
  );

  const setFilter = useCallback(
    (filter: JobFilterStatus) => {
      updateUiState({ filter, page: 1 });
    },
    [updateUiState]
  );

  const setPage = useCallback(
    (updater: number | ((prev: number) => number)) => {
      updateUiState((prev) => {
        const rawNext = typeof updater === 'function' ? updater(prev.page) : updater;
        return {
          ...prev,
          page: Math.max(1, Math.floor(rawNext)),
        };
      });
    },
    [updateUiState]
  );

  return {
    filter: uiState.filter,
    page: uiState.page,
    setFilter,
    setPage,
  };
}

export async function revalidateJobsQueries(mutate: SwrMutateFn): Promise<void> {
  await mutate((key) => typeof key === 'string' && key.startsWith('/api/jobs'));
}

export async function clearAllSwrCaches(
  cache: SwrCacheObj,
  mutate: SwrMutateFn
): Promise<void> {
  clearPersistedSwrSession();
  const keys = Array.from(cache.keys());
  for (const key of keys) {
    cache.delete(key);
  }
  await mutate(() => true, undefined, { revalidate: false });
}
