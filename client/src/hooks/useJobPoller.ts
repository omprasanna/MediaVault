'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACTIVE_JOB_STATUSES,
  extractApiError,
  type JobSummary,
} from '@/lib/mediaTypes';

export interface UseJobPollerOptions {
  limit?: number;
  intervalMs?: number;
  enabled?: boolean;
}

export interface UseJobPollerResult {
  jobs: JobSummary[];
  loading: boolean;
  error: string | null;
  isPolling: boolean;
  isTabHidden: boolean;
  activeCount: number;
  lastUpdatedAt: number | null;
  refresh: () => Promise<void>;
}

/**
 * Polls `GET /api/jobs` every `intervalMs` (default 2500ms) strictly while active
 * jobs (`queued` | `downloading` | `muxing`) exist and the browser tab is visible.
 */
export function useJobPoller({
  limit = 30,
  intervalMs = 2500,
  enabled = true,
}: UseJobPollerOptions = {}): UseJobPollerResult {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState<boolean>(false);
  const [isTabHidden, setIsTabHidden] = useState<boolean>(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef<boolean>(false);

  const clearPollTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const fetchAndSchedule = useCallback(
    async (backgroundPoll: boolean) => {
      if (!enabled || !mountedRef.current) {
        return;
      }

      clearPollTimer();
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        const fetchInit: RequestInit & { priority?: 'high' | 'low' | 'auto' } = {
          cache: 'no-store',
          signal: controller.signal,
        };
        if (backgroundPoll) {
          fetchInit.priority = 'low';
        }

        const res = await fetch(`/api/jobs?limit=${limit}`, fetchInit);
        if (!mountedRef.current || controller.signal.aborted) {
          return;
        }

        if (!res.ok) {
          const msg = await extractApiError(res, `Failed to load jobs (HTTP ${res.status}).`);
          setError(msg);
          setIsPolling(false);
          return;
        }

        const data = (await res.json()) as { jobs?: JobSummary[] };
        const nextJobs = Array.isArray(data.jobs) ? data.jobs : [];
        const nextActiveCount = nextJobs.filter((job) =>
          ACTIVE_JOB_STATUSES.has(job.status)
        ).length;

        setJobs(nextJobs);
        setError(null);
        setLastUpdatedAt(Date.now());

        window.dispatchEvent(
          new CustomEvent('mediavault:jobs-updated', {
            detail: { activeCount: nextActiveCount },
          })
        );

        const visible =
          typeof document === 'undefined' || document.visibilityState === 'visible';
        if (nextActiveCount > 0 && visible && enabled) {
          setIsPolling(true);
          timerRef.current = setTimeout(() => {
            void fetchAndSchedule(true);
          }, intervalMs);
        } else {
          setIsPolling(false);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        if (mountedRef.current) {
          setError('Unable to reach MediaVault job API.');
          setIsPolling(false);
        }
      } finally {
        if (mountedRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [clearPollTimer, enabled, intervalMs, limit]
  );

  useEffect(() => {
    mountedRef.current = true;
    setIsTabHidden(
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
    );

    if (!enabled) {
      setLoading(false);
      setIsPolling(false);
      return () => {
        mountedRef.current = false;
      };
    }

    void fetchAndSchedule(false);

    function handleVisibilityChange() {
      const hidden = document.visibilityState === 'hidden';
      setIsTabHidden(hidden);

      if (hidden) {
        clearPollTimer();
        controllerRef.current?.abort();
        setIsPolling(false);
      } else {
        void fetchAndSchedule(false);
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearPollTimer();
      controllerRef.current?.abort();
    };
  }, [clearPollTimer, enabled, fetchAndSchedule]);

  const refresh = useCallback(async () => {
    await fetchAndSchedule(false);
  }, [fetchAndSchedule]);

  const activeCount = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length;

  return {
    jobs,
    loading,
    error,
    isPolling,
    isTabHidden,
    activeCount,
    lastUpdatedAt,
    refresh,
  };
}
