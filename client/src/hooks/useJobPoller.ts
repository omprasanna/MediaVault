'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  ACTIVE_JOB_STATUSES,
  type JobCounts,
  type JobSummary,
  type JobsPagination,
} from '@/lib/mediaTypes';
import {
  revalidateJobsQueries,
  swrJsonFetcher,
  type JobFilterStatus,
} from '@/lib/swrStore';

export type { JobFilterStatus };

export interface UseJobPollerOptions {
  page?: number;
  limit?: number;
  status?: JobFilterStatus;
  prioritizeActive?: boolean;
  intervalMs?: number;
  enabled?: boolean;
}

export interface UseJobPollerResult {
  jobs: JobSummary[];
  counts: JobCounts;
  pagination: JobsPagination;
  loading: boolean;
  error: string | null;
  isPolling: boolean;
  isTabHidden: boolean;
  activeCount: number;
  lastUpdatedAt: number | null;
  refresh: () => Promise<void>;
}

interface JobsApiResponse {
  jobs?: JobSummary[];
  counts?: Partial<JobCounts>;
  pagination?: Partial<JobsPagination>;
}

const DEFAULT_COUNTS: JobCounts = {
  all: 0,
  active: 0,
  paused: 0,
  ready: 0,
  failed: 0,
  history: 0,
};

function normalizeJobsResponse(
  data: JobsApiResponse | undefined,
  page: number,
  limit: number
): { jobs: JobSummary[]; counts: JobCounts; pagination: JobsPagination } {
  const nextJobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const fallbackActive = nextJobs.filter((job) =>
    ACTIVE_JOB_STATUSES.has(job.status)
  ).length;
  const fallbackPaused = nextJobs.filter((job) => job.status === 'paused').length;
  const fallbackReady = nextJobs.filter((job) => job.status === 'ready').length;
  const fallbackFailed = nextJobs.filter((job) => job.status === 'failed').length;
  const fallbackHistory = nextJobs.filter(
    (job) => job.status === 'expired' || job.status === 'cancelled'
  ).length;

  const nextCounts: JobCounts = data
    ? {
        all:
          typeof data.counts?.all === 'number'
            ? data.counts.all
            : fallbackActive + fallbackPaused + fallbackReady + fallbackFailed,
        active:
          typeof data.counts?.active === 'number' ? data.counts.active : fallbackActive,
        paused:
          typeof data.counts?.paused === 'number' ? data.counts.paused : fallbackPaused,
        ready:
          typeof data.counts?.ready === 'number' ? data.counts.ready : fallbackReady,
        failed:
          typeof data.counts?.failed === 'number' ? data.counts.failed : fallbackFailed,
        history:
          typeof data.counts?.history === 'number'
            ? data.counts.history
            : fallbackHistory,
      }
    : DEFAULT_COUNTS;

  const total =
    typeof data?.pagination?.total === 'number'
      ? data.pagination.total
      : nextJobs.length;
  const pages =
    typeof data?.pagination?.pages === 'number'
      ? Math.max(1, data.pagination.pages)
      : 1;
  const currentPage =
    typeof data?.pagination?.page === 'number' ? data.pagination.page : page;

  return {
    jobs: nextJobs,
    counts: nextCounts,
    pagination: {
      total,
      page: currentPage,
      limit:
        typeof data?.pagination?.limit === 'number' ? data.pagination.limit : limit,
      pages,
      hasMore:
        typeof data?.pagination?.hasMore === 'boolean'
          ? data.pagination.hasMore
          : currentPage < pages,
    },
  };
}

/**
 * Polls `GET /api/jobs` via SWR every `intervalMs` (default 2500ms) strictly while
 * active jobs (`queued` | `downloading` | `muxing`) exist and the tab is visible.
 */
export function useJobPoller({
  page = 1,
  limit = 50,
  status = 'all',
  prioritizeActive = false,
  intervalMs = 2500,
  enabled = true,
}: UseJobPollerOptions = {}): UseJobPollerResult {
  const { mutate: globalMutate } = useSWRConfig();
  const [isTabHidden, setIsTabHidden] = useState<boolean>(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const swrKey = useMemo(() => {
    if (!enabled) {
      return null;
    }
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    if (prioritizeActive) {
      params.set('prioritizeActive', 'true');
    }
    if (status && status !== 'all') {
      params.set('status', status);
    }
    return `/api/jobs?${params.toString()}`;
  }, [enabled, limit, page, prioritizeActive, status]);

  const {
    data,
    error: swrError,
    isLoading,
    mutate,
  } = useSWR<JobsApiResponse>(swrKey, swrJsonFetcher, {
    refreshInterval: (latestData) => {
      if (!enabled || isTabHidden) {
        return 0;
      }
      const parsed = normalizeJobsResponse(latestData, page, limit);
      return parsed.counts.active > 0 ? intervalMs : 0;
    },
    refreshWhenHidden: false,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    keepPreviousData: true,
    onSuccess: () => {
      setLastUpdatedAt(Date.now());
    },
  });

  const normalized = useMemo(
    () => normalizeJobsResponse(data, page, limit),
    [data, limit, page]
  );

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    setIsTabHidden(document.visibilityState === 'hidden');

    function handleVisibilityChange() {
      const hidden = document.visibilityState === 'hidden';
      setIsTabHidden(hidden);
      if (!hidden && enabled && swrKey) {
        void mutate();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [enabled, mutate, swrKey]);

  useEffect(() => {
    if (typeof window === 'undefined' || !data) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent('mediavault:jobs-updated', {
        detail: { activeCount: normalized.counts.active },
      })
    );
  }, [data, normalized.counts.active]);

  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }
    await revalidateJobsQueries(globalMutate);
  }, [enabled, globalMutate]);

  const error = swrError
    ? swrError instanceof Error
      ? swrError.message
      : 'Unable to reach MediaVault job API.'
    : null;

  return {
    jobs: normalized.jobs,
    counts: normalized.counts,
    pagination: normalized.pagination,
    loading: Boolean(enabled && !data && isLoading),
    error,
    isPolling: Boolean(enabled && !isTabHidden && normalized.counts.active > 0),
    isTabHidden,
    activeCount: normalized.counts.active,
    lastUpdatedAt,
    refresh,
  };
}
