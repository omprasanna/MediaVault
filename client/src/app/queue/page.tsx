'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Cookie,
  Download,
  Film,
  Headphones,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { useJobPoller } from '@/hooks/useJobPoller';
import {
  extractApiErrorInfo,
  formatBytes,
  formatDuration,
  formatExpiryCountdown,
  formatPlatformLabel,
  type JobSummary,
} from '@/lib/mediaTypes';
import { useDownloaderState, useQueueUiState } from '@/lib/swrStore';

function isAuthRelatedError(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  return /cookie|sign\s?in|auth|age|private|login|members?|403/i.test(errorMessage);
}

function formatHistoryTimestamp(isoDate: string): string {
  const parsed = Date.parse(isoDate);
  if (!Number.isFinite(parsed)) return '--';
  const date = new Date(parsed);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function QueuePage() {
  const { filter, page, setFilter, setPage } = useQueueUiState();
  const { updateState: updateDownloaderState } = useDownloaderState();

  const {
    jobs,
    counts,
    pagination,
    loading,
    error,
    isPolling,
    isTabHidden,
    refresh,
  } = useJobPoller({
    page,
    limit: 50,
    status: filter,
    prioritizeActive: true,
    intervalMs: 2500,
  });

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [failedThumbIds, setFailedThumbIds] = useState<Set<string>>(() => new Set());
  const [clearingExpired, setClearingExpired] = useState<boolean>(false);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [pausingJobId, setPausingJobId] = useState<string | null>(null);
  const [resumingJobId, setResumingJobId] = useState<string | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<'pause-all' | 'resume-all' | 'clear-all' | null>(
    null
  );
  const [deleteReadyFiles, setDeleteReadyFiles] = useState<boolean>(false);
  const clearDialogRef = useRef<HTMLDialogElement>(null);
  const clearDialogTitleId = useId();
  const [actionFeedback, setActionFeedback] = useState<{
    kind: 'error' | 'info';
    message: string;
    needsCookieSetup?: boolean;
  } | null>(null);

  const totalQueueCount = counts.all + counts.history;

  const primaryJobs = useMemo(
    () =>
      jobs.filter(
        (job) => job.status !== 'expired' && job.status !== 'cancelled'
      ),
    [jobs]
  );

  const historyJobs = useMemo(
    () =>
      jobs.filter(
        (job) => job.status === 'expired' || job.status === 'cancelled'
      ),
    [jobs]
  );

  const readyJobsExist = useMemo(
    () => primaryJobs.some((job) => job.status === 'ready' && Boolean(job.expiresAt)),
    [primaryJobs]
  );

  useEffect(() => {
    if (!loading && page > pagination.pages) {
      setPage(pagination.pages);
    }
  }, [loading, page, pagination.pages]);

  useEffect(() => {
    if (!readyJobsExist) {
      return;
    }
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 15000);
    return () => clearInterval(timer);
  }, [readyJobsExist]);

  useEffect(() => {
    const dialog = clearDialogRef.current;
    if (!dialog || 'closedBy' in HTMLDialogElement.prototype) {
      return;
    }

    const isOutside = (e: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      return (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      );
    };

    let pressedOutside = false;
    const handlePointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const handlePointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener('pointerdown', handlePointerDown);
    dialog.addEventListener('pointerup', handlePointerUp);
    return () => {
      dialog.removeEventListener('pointerdown', handlePointerDown);
      dialog.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);

  const filteredJobs = primaryJobs;

  async function handleClearExpired() {
    if (clearingExpired || bulkAction !== null || counts.history === 0) {
      return;
    }
    setClearingExpired(true);
    setActionFeedback(null);

    try {
      const res = await fetch('/api/jobs/expired', {
        method: 'DELETE',
        cache: 'no-store',
      });
      if (!res.ok) {
        const info = await extractApiErrorInfo(res, 'Failed to clear expired jobs.');
        setActionFeedback({ kind: 'error', message: info.message });
        return;
      }
      const data = (await res.json()) as { deletedCount?: number };
      setActionFeedback({
        kind: 'info',
        message: `Cleared ${data.deletedCount ?? 0} expired history record(s).`,
      });
      await refresh();
    } catch {
      setActionFeedback({
        kind: 'error',
        message: 'Network error while clearing expired jobs.',
      });
    } finally {
      setClearingExpired(false);
    }
  }

  function openClearQueueDialog() {
    if (bulkAction !== null || clearingExpired || totalQueueCount === 0) {
      return;
    }
    setDeleteReadyFiles(false);
    clearDialogRef.current?.showModal();
  }

  async function handleClearQueue(deleteFiles: boolean) {
    if (bulkAction !== null || clearingExpired || totalQueueCount === 0) {
      return;
    }
    setBulkAction('clear-all');
    setActionFeedback(null);

    try {
      const res = await fetch(
        `/api/jobs?deleteFiles=${deleteFiles ? 'true' : 'false'}`,
        {
          method: 'DELETE',
          cache: 'no-store',
        }
      );
      if (!res.ok) {
        const info = await extractApiErrorInfo(res, 'Failed to clear queue.');
        setActionFeedback({ kind: 'error', message: info.message });
        return;
      }
      const data = (await res.json()) as {
        deletedCount?: number;
        cancelledActiveCount?: number;
        deletedFilesCount?: number;
      };
      const deletedCount = data.deletedCount ?? 0;
      const cancelledCount = data.cancelledActiveCount ?? 0;
      const deletedFilesCount = data.deletedFilesCount ?? 0;

      const parts = [`Cleared ${deletedCount} job(s) from queue`];
      if (cancelledCount > 0) {
        parts.push(`${cancelledCount} active cancelled`);
      }
      if (deletedFilesCount > 0) {
        parts.push(`${deletedFilesCount} file(s) deleted from Downloads`);
      }

      setActionFeedback({
        kind: 'info',
        message: `${parts.join(' · ')}.`,
      });
      setPage(1);
      updateDownloaderState({ trackedJobIds: [] });
      await refresh();
    } catch {
      setActionFeedback({
        kind: 'error',
        message: 'Network error while clearing queue.',
      });
    } finally {
      setBulkAction(null);
    }
  }

  function handleClearDialogClose() {
    const dialog = clearDialogRef.current;
    if (!dialog) {
      return;
    }
    const action = dialog.returnValue;
    dialog.returnValue = '';
    if (action === 'confirm') {
      void handleClearQueue(deleteReadyFiles);
    }
  }

  async function handlePauseJob(job: JobSummary) {
    if (pausingJobId || bulkAction) {
      return;
    }
    setPausingJobId(job.id);
    setActionFeedback(null);

    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/pause`, {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) {
        const info = await extractApiErrorInfo(res, 'Failed to pause download.');
        setActionFeedback({ kind: 'error', message: info.message });
        return;
      }
      setActionFeedback({
        kind: 'info',
        message: `Paused "${job.title}". Partial data has been preserved.`,
      });
      await refresh();
    } catch {
      setActionFeedback({
        kind: 'error',
        message: 'Network error while pausing download.',
      });
    } finally {
      setPausingJobId(null);
    }
  }

  async function handlePauseAll() {
    if (bulkAction || counts.active === 0) {
      return;
    }
    setBulkAction('pause-all');
    setActionFeedback(null);

    try {
      const res = await fetch('/api/jobs/pause-all', {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) {
        const info = await extractApiErrorInfo(res, 'Failed to pause active downloads.');
        setActionFeedback({ kind: 'error', message: info.message });
        return;
      }
      const data = (await res.json()) as { pausedCount?: number };
      setActionFeedback({
        kind: 'info',
        message: `Paused ${data.pausedCount ?? 0} active/queued download(s).`,
      });
      await refresh();
    } catch {
      setActionFeedback({
        kind: 'error',
        message: 'Network error while pausing all downloads.',
      });
    } finally {
      setBulkAction(null);
    }
  }

  async function handleResumeJob(job: JobSummary) {
    if (resumingJobId || bulkAction) {
      return;
    }
    setResumingJobId(job.id);
    setActionFeedback(null);

    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/resume`, {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) {
        const info = await extractApiErrorInfo(res, 'Failed to resume download.');
        setActionFeedback({
          kind: 'error',
          message: info.message,
          needsCookieSetup: info.code === 'COOKIE_NOT_FOUND',
        });
        return;
      }
      setActionFeedback({
        kind: 'info',
        message: `Resumed "${job.title}". Continuing from partial file if available.`,
      });
      await refresh();
    } catch {
      setActionFeedback({
        kind: 'error',
        message: 'Network error while resuming download.',
      });
    } finally {
      setResumingJobId(null);
    }
  }

  async function handleResumeAll() {
    if (bulkAction || counts.paused === 0) {
      return;
    }
    setBulkAction('resume-all');
    setActionFeedback(null);

    try {
      const res = await fetch('/api/jobs/resume-all', {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) {
        const info = await extractApiErrorInfo(res, 'Failed to resume paused downloads.');
        setActionFeedback({ kind: 'error', message: info.message });
        return;
      }
      const data = (await res.json()) as { resumedCount?: number };
      setActionFeedback({
        kind: 'info',
        message: `Resumed ${data.resumedCount ?? 0} paused download(s).`,
      });
      await refresh();
    } catch {
      setActionFeedback({
        kind: 'error',
        message: 'Network error while resuming paused downloads.',
      });
    } finally {
      setBulkAction(null);
    }
  }

  async function handleRetryJob(
    job: JobSummary,
    { useCookies = false }: { useCookies?: boolean } = {}
  ) {
    if (retryingJobId || bulkAction) {
      return;
    }
    setRetryingJobId(job.id);
    setActionFeedback(null);

    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ useCookies }),
      });

      if (!res.ok) {
        const info = await extractApiErrorInfo(res, 'Unable to retry download.');
        setActionFeedback({
          kind: 'error',
          message: info.message,
          needsCookieSetup: info.code === 'COOKIE_NOT_FOUND',
        });
        return;
      }

      setActionFeedback({
        kind: 'info',
        message: useCookies
          ? `Retrying "${job.title}" with saved cookies enabled.`
          : `Retrying "${job.title}" — resuming partial download if present.`,
      });
      await refresh();
    } catch {
      setActionFeedback({
        kind: 'error',
        message: 'Network error while retrying download.',
      });
    } finally {
      setRetryingJobId(null);
    }
  }

  async function handleDeleteJob(job: JobSummary) {
    if (deletingJobId || bulkAction !== null) {
      return;
    }
    setDeletingJobId(job.id);
    setActionFeedback(null);

    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, {
        method: 'DELETE',
        cache: 'no-store',
      });
      if (!res.ok) {
        const info = await extractApiErrorInfo(res, 'Failed to delete job.');
        setActionFeedback({ kind: 'error', message: info.message });
        return;
      }
      const data = (await res.json()) as { fileDeleted?: boolean };
      setActionFeedback({
        kind: 'info',
        message: data.fileDeleted
          ? `Deleted "${job.fileName || job.title}" from Downloads.`
          : `Removed "${job.title}" from queue.`,
      });
      await refresh();
    } catch {
      setActionFeedback({
        kind: 'error',
        message: 'Network error while deleting job.',
      });
    } finally {
      setDeletingJobId(null);
    }
  }

  const pollDotClass = isPolling
    ? 'bg-ready-dot'
    : isTabHidden && counts.active > 0
      ? 'bg-muxing-dot'
      : 'bg-border-strong';

  const pollStatusLabel = isPolling
    ? 'BullMQ worker · Polling every 2.5s'
    : isTabHidden && counts.active > 0
      ? 'BullMQ worker · Polling paused (tab hidden)'
      : 'BullMQ worker · Idle';

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-6">
      {/* Header Row */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-[-0.015em] text-ink-primary">
            Queue &amp; History
          </h1>
          <div
            data-testid="queue-poll-status"
            className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-ink-secondary"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              {isPolling && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ready-dot opacity-75" />
              )}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${pollDotClass}`} />
            </span>
            <span>{pollStatusLabel}</span>
          </div>
        </div>

        {/* Filter Pills & Clear Expired */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Filter jobs by status"
            className="flex items-center gap-1 rounded-xl border border-border-default bg-surface-recessed p-1 shadow-[var(--shadow-xs)]"
          >
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'active', label: 'Active' },
                { id: 'paused', label: 'Paused' },
                { id: 'ready', label: 'Ready' },
                { id: 'failed', label: 'Failed' },
              ] as const
            ).map((pill) => {
              const selected = filter === pill.id;
              return (
                <button
                  key={pill.id}
                  type="button"
                  aria-pressed={selected}
                  data-testid={`filter-${pill.id}`}
                  onClick={() => setFilter(pill.id)}
                  className={`mv-focus inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[13px] transition-colors ${
                    selected
                      ? 'border-border-default bg-surface-elevated font-semibold text-ink-primary shadow-[var(--shadow-xs)]'
                      : 'border-transparent font-medium text-ink-secondary hover:bg-surface hover:text-ink-primary'
                  }`}
                >
                  <span>{pill.label}</span>
                  <span className="font-mono text-[11px] tabular-nums text-ink-muted">
                    {counts[pill.id]}
                  </span>
                </button>
              );
            })}
          </div>

          {counts.active > 0 && (
            <button
              type="button"
              disabled={bulkAction !== null}
              onClick={() => void handlePauseAll()}
              data-testid="pause-all-btn"
              className="mv-focus inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border-default bg-surface-elevated px-3 text-[13px] font-medium text-ink-primary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong hover:bg-surface-high disabled:cursor-not-allowed disabled:opacity-50 sm:h-8"
            >
              {bulkAction === 'pause-all' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{bulkAction === 'pause-all' ? 'Pausing...' : 'Pause All'}</span>
            </button>
          )}

          {counts.paused > 0 && (
            <button
              type="button"
              disabled={bulkAction !== null}
              onClick={() => void handleResumeAll()}
              data-testid="resume-all-btn"
              className="mv-focus inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:h-8"
            >
              {bulkAction === 'resume-all' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{bulkAction === 'resume-all' ? 'Resuming...' : 'Resume All'}</span>
            </button>
          )}

          <button
            type="button"
            disabled={clearingExpired || bulkAction !== null || counts.history === 0}
            onClick={handleClearExpired}
            data-testid="clear-expired-btn"
            className="mv-focus inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border-default bg-surface-elevated px-3 text-[13px] font-medium text-ink-secondary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary disabled:cursor-not-allowed disabled:opacity-45 sm:h-8"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Clear Expired</span>
          </button>

          <button
            type="button"
            disabled={totalQueueCount === 0 || bulkAction !== null || clearingExpired}
            onClick={openClearQueueDialog}
            data-testid="clear-queue-btn"
            className="mv-focus inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-failed-border bg-failed-bg px-3 text-[13px] font-medium text-failed shadow-[var(--shadow-xs)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 sm:h-8"
          >
            {bulkAction === 'clear-all' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{bulkAction === 'clear-all' ? 'Clearing...' : 'Clear Queue'}</span>
          </button>

          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh jobs list"
            title="Refresh jobs list"
            className="mv-focus inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-border-default bg-surface-elevated text-ink-secondary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary sm:h-8 sm:w-8"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {/* Errors / Action Feedback */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-failed-border bg-failed-bg px-4 py-3 text-xs text-failed"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {actionFeedback && (
        <div
          role={actionFeedback.kind === 'error' ? 'alert' : 'status'}
          className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-2.5 text-xs ${
            actionFeedback.kind === 'error'
              ? 'border-failed-border bg-failed-bg text-failed'
              : 'border-ready-border bg-ready-bg text-ready'
          }`}
        >
          <span>{actionFeedback.message}</span>
          {actionFeedback.needsCookieSetup && (
            <Link href="/settings" className="font-semibold underline">
              Upload cookies in Settings →
            </Link>
          )}
        </div>
      )}

      {/* Primary Job Cards */}
      {loading && primaryJobs.length === 0 ? (
        <section className="flex flex-col gap-3" aria-label="Loading jobs">
          {[1, 2].map((skeleton) => (
            <div
              key={skeleton}
              className="flex flex-col gap-4 rounded-xl border border-border-default bg-surface p-4 sm:flex-row sm:items-center"
            >
              <div className="aspect-video w-full animate-pulse rounded-lg bg-surface-high sm:w-36" />
              <div className="flex flex-1 flex-col gap-2">
                <div className="h-4 w-2/3 animate-pulse rounded bg-surface-high" />
                <div className="h-2 w-full animate-pulse rounded bg-surface-high" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-surface-high" />
              </div>
            </div>
          ))}
        </section>
      ) : filteredJobs.length === 0 ? (
        <section className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border-default bg-surface px-6 py-12 text-center shadow-[var(--shadow-xs)]">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border-default bg-surface-elevated text-ink-muted">
            <Film className="h-5 w-5" aria-hidden="true" />
          </div>
          <h2 className="text-sm font-semibold text-ink-primary">
            {counts.all === 0
              ? 'No active or completed jobs yet'
              : `No ${filter} jobs`}
          </h2>
          <p className="max-w-sm text-[13px] text-ink-secondary">
            {counts.all === 0
              ? 'Enqueued 1080p stream-copy muxes, playlist batches, and MP3 extractions will update here automatically every 2.5s.'
              : 'Switch filters above or inspect a new media URL in Downloader.'}
          </p>
          <Link
            href="/"
            className="mv-focus mt-1 inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-[13px] font-semibold text-on-accent transition-colors hover:bg-accent-hover"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Back to Downloader</span>
          </Link>
        </section>
      ) : (
        <section aria-label="Download queue jobs" className="flex flex-col gap-2.5">
          {filteredJobs.map((job) => {
            const thumbFailed = failedThumbIds.has(job.id);
            const isActiveDownload = job.status === 'queued' || job.status === 'downloading';
            const isMuxing = job.status === 'muxing';
            const isPaused = job.status === 'paused';
            const isReady = job.status === 'ready';
            const isFailed = job.status === 'failed';
            const progressPercent = Math.min(100, Math.max(0, Math.round(job.progress || 0)));
            const containerSpec =
              job.mode === 'audio' ? '320K MP3' : job.container.toUpperCase();

            return (
              <article
                key={job.id}
                data-testid={`job-card-${job.id}`}
                data-status={job.status}
                className="flex flex-col items-start gap-4 rounded-xl border border-border-default bg-surface-elevated p-4 shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong sm:flex-row sm:items-center"
              >
                {/* 16:9 Thumbnail */}
                <div
                  className={`relative aspect-video w-full shrink-0 overflow-hidden rounded-lg border border-border-default bg-surface-recessed sm:w-36 ${
                    isFailed ? 'opacity-75' : ''
                  }`}
                >
                  {job.thumbnailUrl && !thumbFailed ? (
                    <img
                      src={job.thumbnailUrl}
                      alt={job.title}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      width={144}
                      height={81}
                      onError={() =>
                        setFailedThumbIds((prev) => new Set(prev).add(job.id))
                      }
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-ink-muted">
                      {job.mode === 'audio' ? (
                        <Headphones className="h-6 w-6" aria-hidden="true" />
                      ) : (
                        <Video className="h-6 w-6" aria-hidden="true" />
                      )}
                    </div>
                  )}

                  {typeof job.duration === 'number' && job.duration > 0 && (
                    <span className="absolute right-1.5 bottom-1.5 rounded border border-border-subtle bg-surface-recessed/90 px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-ink-primary">
                      {formatDuration(job.duration)}
                    </span>
                  )}
                </div>

                {/* Queued / Downloading Card Layout */}
                {isActiveDownload && (
                  <div className="flex w-full min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="min-w-0 truncate text-sm font-semibold text-ink-primary">
                        {job.title}
                      </h2>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary">
                          {containerSpec}
                        </span>
                        <span className="font-mono text-[11px] uppercase text-ink-muted">
                          {job.status === 'queued' ? 'Queued' : 'Downloading'}
                        </span>
                        <button
                          type="button"
                          disabled={pausingJobId === job.id || retryingJobId === job.id}
                          onClick={() => void handlePauseJob(job)}
                          aria-label={`Pause ${job.title}`}
                          title="Pause download (keeps partial file)"
                          data-testid={`pause-job-btn-${job.id}`}
                          className="mv-focus inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border-default bg-surface px-2 text-xs font-medium text-ink-secondary transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary disabled:opacity-50"
                        >
                          {pausingJobId === job.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          ) : (
                            <Pause className="h-3 w-3" aria-hidden="true" />
                          )}
                          <span>Pause</span>
                        </button>
                        {job.status === 'downloading' && (
                          <button
                            type="button"
                            disabled={retryingJobId === job.id || pausingJobId === job.id}
                            onClick={() => void handleRetryJob(job, { useCookies: false })}
                            aria-label={`Retry ${job.title}`}
                            title="Retry stalled or disconnected download"
                            data-testid={`retry-job-btn-${job.id}`}
                            className="mv-focus inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border-default bg-surface px-2 text-xs font-medium text-ink-secondary transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary disabled:opacity-50"
                          >
                            {retryingJobId === job.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                            ) : (
                              <RotateCw className="h-3 w-3" aria-hidden="true" />
                            )}
                            <span>Retry</span>
                          </button>
                        )}
                        {job.status === 'queued' && (
                          <button
                            type="button"
                            disabled={deletingJobId === job.id}
                            onClick={() => void handleDeleteJob(job)}
                            aria-label={`Remove ${job.title} from queue`}
                            title="Remove queued job"
                            data-testid={`delete-job-btn-${job.id}`}
                            className="mv-focus inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border-default bg-surface text-ink-muted transition-colors hover:border-failed-border hover:bg-failed-bg hover:text-failed disabled:opacity-50"
                          >
                            {deletingJobId === job.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>

                    <progress
                      className="mv-progress"
                      max={100}
                      value={progressPercent}
                      aria-label={`Download progress for ${job.title}`}
                    />

                    <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
                      <span className="font-medium text-accent-text">
                        {progressPercent}%
                        {job.downloadSpeed ? ` · ${job.downloadSpeed}` : ''}
                      </span>
                      <span className="text-ink-muted">
                        {job.eta
                          ? `ETA ${job.eta}`
                          : formatPlatformLabel(job.platform, job.sourceUrl)}
                      </span>
                    </div>
                  </div>
                )}

                {/* Amber Fast Muxing Card Layout */}
                {isMuxing && (
                  <div className="flex w-full min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="min-w-0 truncate text-sm font-semibold text-ink-primary">
                        {job.title}
                      </h2>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary">
                          {containerSpec}
                        </span>
                        <span className="rounded border border-muxing-border bg-muxing-bg px-2 py-0.5 font-mono text-[11px] font-medium uppercase text-muxing">
                          Fast Muxing
                        </span>
                      </div>
                    </div>

                    <progress
                      className="mv-progress mv-progress-muxing"
                      aria-label={`Muxing ${job.title}`}
                    />

                    <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums text-ink-secondary">
                      <span className="truncate">
                        {job.mode === 'audio'
                          ? 'Extracting 320kbps MP3 audio stream'
                          : 'Merging video + audio streams (-c copy)'}
                      </span>
                      <span className="shrink-0 text-muxing">{progressPercent}%</span>
                    </div>
                  </div>
                )}

                {/* Paused Card Layout */}
                {isPaused && (
                  <div className="flex w-full min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="min-w-0 truncate text-sm font-semibold text-ink-primary">
                        {job.title}
                      </h2>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary">
                          {containerSpec}
                        </span>
                        <span className="rounded border border-muxing-border bg-muxing-bg px-2 py-0.5 font-mono text-[11px] font-medium uppercase text-muxing">
                          Paused
                        </span>
                        <button
                          type="button"
                          disabled={resumingJobId === job.id || retryingJobId === job.id}
                          onClick={() => void handleResumeJob(job)}
                          data-testid={`resume-job-btn-${job.id}`}
                          className="mv-focus inline-flex h-7 cursor-pointer items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
                        >
                          {resumingJobId === job.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          ) : (
                            <Play className="h-3 w-3" aria-hidden="true" />
                          )}
                          <span>{resumingJobId === job.id ? 'Resuming...' : 'Resume'}</span>
                        </button>
                        <button
                          type="button"
                          disabled={deletingJobId === job.id}
                          onClick={() => void handleDeleteJob(job)}
                          aria-label={`Delete paused job ${job.title}`}
                          title="Delete paused job and partial file"
                          data-testid={`delete-job-btn-${job.id}`}
                          className="mv-focus inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border-default bg-surface text-ink-muted transition-colors hover:border-failed-border hover:bg-failed-bg hover:text-failed disabled:opacity-50"
                        >
                          {deletingJobId === job.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </div>

                    <progress
                      className="mv-progress"
                      max={100}
                      value={progressPercent}
                      aria-label={`Paused progress for ${job.title}`}
                    />

                    <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
                      <span className="font-medium text-muxing">
                        {progressPercent}% · Paused — resumes from partial file
                      </span>
                      <span className="text-ink-muted">
                        {formatPlatformLabel(job.platform, job.sourceUrl)}
                      </span>
                    </div>
                  </div>
                )}

                {/* Green Ready Card Layout */}
                {isReady && (
                  <div className="flex w-full min-w-0 flex-1 flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <h2 className="truncate text-sm font-semibold text-ink-primary">
                        {job.title}
                      </h2>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary">
                          {job.container.toUpperCase()} · {formatBytes(job.fileSizeBytes)}
                        </span>
                        <span className="rounded border border-ready-border bg-ready-bg px-2 py-0.5 font-mono text-[11px] font-medium uppercase text-ready">
                          Ready
                        </span>
                        <span className="font-mono text-[11px] tabular-nums text-ink-muted">
                          {formatExpiryCountdown(job.expiresAt, nowMs)}
                        </span>
                      </div>
                      {job.fileName && (
                        <p className="truncate font-mono text-[11px] text-ink-secondary">
                          {job.fileName}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <a
                        href={`/api/jobs/${encodeURIComponent(job.id)}/file`}
                        download
                        data-testid={`save-file-btn-${job.id}`}
                        className="mv-focus inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover active:bg-accent-active sm:h-8 sm:flex-initial"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        <span>Save File</span>
                      </a>

                      <button
                        type="button"
                        disabled={deletingJobId === job.id}
                        onClick={() => void handleDeleteJob(job)}
                        aria-label={`Delete ${job.fileName || job.title}`}
                        title="Delete file from Downloads and remove job"
                        data-testid={`delete-job-btn-${job.id}`}
                        className="mv-focus inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border-default bg-surface text-ink-secondary shadow-[var(--shadow-xs)] transition-colors hover:border-failed-border hover:bg-failed-bg hover:text-failed disabled:opacity-50 sm:h-8 sm:w-8"
                      >
                        {deletingJobId === job.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Failed Card Layout */}
                {isFailed && (
                  <div className="flex w-full min-w-0 flex-1 flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="min-w-0 truncate text-sm font-semibold text-ink-primary">
                          {job.title}
                        </h2>
                        <span className="shrink-0 rounded border border-failed-border bg-failed-bg px-2 py-0.5 font-mono text-[11px] font-medium uppercase text-failed">
                          {isAuthRelatedError(job.errorMessage)
                            ? 'Auth Required'
                            : 'Failed'}
                        </span>
                      </div>
                      <p className="truncate font-mono text-xs text-failed">
                        {job.errorMessage || 'Download or stream-copy mux failed.'}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={retryingJobId === job.id}
                        onClick={() => void handleRetryJob(job, { useCookies: false })}
                        data-testid={`retry-job-btn-${job.id}`}
                        className="mv-focus inline-flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover disabled:cursor-wait disabled:opacity-60 sm:h-8 sm:flex-initial"
                      >
                        {retryingJobId === job.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <RotateCw className="h-4 w-4" aria-hidden="true" />
                        )}
                        <span>{retryingJobId === job.id ? 'Retrying...' : 'Retry'}</span>
                      </button>

                      {job.sourceUrl && (
                        <button
                          type="button"
                          disabled={retryingJobId === job.id}
                          onClick={() => void handleRetryJob(job, { useCookies: true })}
                          data-testid={`retry-cookies-btn-${job.id}`}
                          className="mv-focus inline-flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border-default bg-surface px-3 text-[13px] font-medium text-ink-primary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong hover:bg-surface-high disabled:cursor-wait disabled:opacity-60 sm:h-8 sm:flex-initial"
                        >
                          {retryingJobId === job.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Cookie className="h-4 w-4 text-ink-secondary" aria-hidden="true" />
                          )}
                          <span>
                            {retryingJobId === job.id ? 'Retrying...' : 'Retry with Cookies'}
                          </span>
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={deletingJobId === job.id}
                        onClick={() => void handleDeleteJob(job)}
                        aria-label={`Delete failed job ${job.title}`}
                        title="Delete failed job"
                        data-testid={`delete-job-btn-${job.id}`}
                        className="mv-focus inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border-default bg-surface text-ink-secondary shadow-[var(--shadow-xs)] transition-colors hover:border-failed-border hover:bg-failed-bg hover:text-failed disabled:opacity-50 sm:h-8 sm:w-8"
                      >
                        {deletingJobId === job.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}

          {pagination.pages > 1 && (
            <nav
              aria-label="Queue pagination"
              data-testid="queue-pagination"
              className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-default bg-surface px-4 py-2.5 shadow-[var(--shadow-xs)]"
            >
              <span className="font-mono text-xs tabular-nums text-ink-secondary">
                Page {pagination.page} of {pagination.pages} ({pagination.total} items)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pagination.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="mv-focus inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-border-default bg-surface-elevated px-2.5 text-xs font-medium text-ink-secondary transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Previous</span>
                </button>
                <button
                  type="button"
                  disabled={!pagination.hasMore}
                  onClick={() => setPage((p) => p + 1)}
                  className="mv-focus inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-border-default bg-surface-elevated px-2.5 text-xs font-medium text-ink-secondary transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span>Next</span>
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </nav>
          )}
        </section>
      )}

      {/* Compact History Section (Expired / Cancelled) */}
      {historyJobs.length > 0 && (
        <section aria-label="Expired download history" className="flex flex-col gap-2.5 pt-2">
          <div className="flex items-center gap-3">
            <h2 className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-muted">
              History
            </h2>
            <div className="h-px flex-1 bg-border-subtle" />
            <span className="font-mono text-[11px] tabular-nums text-ink-muted">
              {historyJobs.length} expired
            </span>
          </div>

          <div className="flex flex-col gap-1.5" data-testid="history-list">
            {historyJobs.map((job) => (
              <div
                key={job.id}
                data-testid={`history-row-${job.id}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-surface px-3.5 py-2.5 shadow-[var(--shadow-xs)] transition-colors hover:bg-surface-elevated"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className="rounded border border-border-default bg-surface-elevated px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-secondary">
                    {formatPlatformLabel(job.platform, job.sourceUrl)}
                  </span>
                  <span className="truncate text-[13px] font-medium text-ink-primary">
                    {job.title}
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-2.5">
                  <span className="rounded border border-border-default bg-surface-elevated px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary">
                    {job.container.toUpperCase()}
                  </span>
                  <span className="hidden font-mono text-[11px] tabular-nums text-ink-muted sm:inline">
                    {formatHistoryTimestamp(job.createdAt)}
                  </span>
                  <Link
                    href={
                      job.sourceUrl
                        ? `/?url=${encodeURIComponent(job.sourceUrl)}`
                        : '/'
                    }
                    title="Re-inspect URL in Downloader"
                    aria-label={`Re-inspect ${job.title}`}
                    data-testid={`reinspect-link-${job.id}`}
                    className="mv-focus inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border-default bg-surface-elevated text-ink-secondary transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary"
                  >
                    <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Clear Entire Queue Confirmation Dialog */}
      <dialog
        ref={clearDialogRef}
        data-testid="clear-queue-dialog"
        aria-labelledby={clearDialogTitleId}
        {...({ closedby: 'any' } as Record<string, string>)}
        onClose={handleClearDialogClose}
        className="mv-dialog w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border-default bg-surface-elevated text-ink-primary shadow-[var(--shadow-overlay)]"
      >
        <form method="dialog" className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-failed-border bg-failed-bg text-failed">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              </div>
              <h1
                id={clearDialogTitleId}
                className="text-base font-semibold text-ink-primary"
              >
                Clear entire queue?
              </h1>
            </div>

            <button
              type="submit"
              value="cancel"
              aria-label="Close dialog"
              className="mv-focus inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border-default bg-surface text-ink-muted transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="flex flex-col gap-2.5 text-[13px] leading-relaxed text-ink-secondary">
            <p>
              This removes all{' '}
              <span className="font-mono font-semibold text-ink-primary">
                {totalQueueCount}
              </span>{' '}
              job(s) from Queue &amp; History, cancels any active downloads, and deletes
              temporary <code className="font-mono text-xs">.part</code> files.
            </p>

            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { label: 'Active', count: counts.active },
                { label: 'Paused', count: counts.paused },
                { label: 'Ready', count: counts.ready },
                { label: 'Failed', count: counts.failed },
                { label: 'History', count: counts.history },
              ]
                .filter((bucket) => bucket.count > 0)
                .map((bucket) => (
                  <span
                    key={bucket.label}
                    className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary"
                  >
                    {bucket.count} {bucket.label}
                  </span>
                ))}
            </div>
          </div>

          {counts.ready > 0 && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border-default bg-surface p-3 text-xs transition-colors hover:border-border-strong">
              <input
                type="checkbox"
                checked={deleteReadyFiles}
                onChange={(e) => setDeleteReadyFiles(e.target.checked)}
                data-testid="clear-queue-delete-files-checkbox"
                className="mv-focus mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border-strong accent-accent"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium text-ink-primary">
                  Also delete {counts.ready} completed{' '}
                  {counts.ready === 1 ? 'file' : 'files'} from Downloads
                </span>
                <span className="text-[11px] leading-relaxed text-ink-secondary">
                  Leave unchecked to remove entries from the queue while keeping your saved
                  media files on disk.
                </span>
              </span>
            </label>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="submit"
              value="cancel"
              autoFocus
              data-testid="clear-queue-cancel-btn"
              className="mv-focus inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border border-border-default bg-surface px-3.5 text-[13px] font-medium text-ink-primary transition-colors hover:border-border-strong hover:bg-surface-high"
            >
              Cancel
            </button>
            <button
              type="submit"
              value="confirm"
              data-testid="clear-queue-confirm-btn"
              className="mv-focus inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border border-failed-border bg-failed-bg px-3.5 text-[13px] font-semibold text-failed transition-opacity hover:opacity-90"
            >
              Clear All ({totalQueueCount})
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
