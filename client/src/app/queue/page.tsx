'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowLeft,
  Cookie,
  Download,
  Film,
  Headphones,
  Loader2,
  RefreshCw,
  RotateCw,
  Trash2,
  Video,
} from 'lucide-react';
import { useJobPoller } from '@/hooks/useJobPoller';
import {
  ACTIVE_JOB_STATUSES,
  extractApiErrorInfo,
  formatBytes,
  formatDuration,
  formatExpiryCountdown,
  formatPlatformLabel,
  type JobSummary,
} from '@/lib/mediaTypes';

type QueueFilter = 'all' | 'active' | 'ready' | 'failed';

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
  const {
    jobs,
    loading,
    error,
    isPolling,
    isTabHidden,
    activeCount,
    refresh,
  } = useJobPoller({ limit: 40, intervalMs: 2500 });

  const [filter, setFilter] = useState<QueueFilter>('all');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [failedThumbIds, setFailedThumbIds] = useState<Set<string>>(() => new Set());
  const [clearingExpired, setClearingExpired] = useState<boolean>(false);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    kind: 'error' | 'info';
    message: string;
    needsCookieSetup?: boolean;
  } | null>(null);

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
    () => primaryJobs.some((job) => job.status === 'ready'),
    [primaryJobs]
  );

  useEffect(() => {
    if (!readyJobsExist) {
      return;
    }
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 15000);
    return () => clearInterval(timer);
  }, [readyJobsExist]);

  const counts = useMemo(
    () => ({
      all: primaryJobs.length,
      active: primaryJobs.filter((j) => ACTIVE_JOB_STATUSES.has(j.status)).length,
      ready: primaryJobs.filter((j) => j.status === 'ready').length,
      failed: primaryJobs.filter((j) => j.status === 'failed').length,
    }),
    [primaryJobs]
  );

  const filteredJobs = useMemo(() => {
    if (filter === 'all') return primaryJobs;
    if (filter === 'active') {
      return primaryJobs.filter((j) => ACTIVE_JOB_STATUSES.has(j.status));
    }
    if (filter === 'ready') {
      return primaryJobs.filter((j) => j.status === 'ready');
    }
    return primaryJobs.filter((j) => j.status === 'failed');
  }, [filter, primaryJobs]);

  async function handleClearExpired() {
    if (clearingExpired || historyJobs.length === 0) {
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

  async function handleRetryWithCookies(job: JobSummary) {
    if (!job.sourceUrl || retryingJobId) {
      return;
    }
    setRetryingJobId(job.id);
    setActionFeedback(null);

    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceUrl: job.sourceUrl,
          useCookies: true,
          items: [
            {
              sourceUrl: job.sourceUrl,
              title: job.title,
              thumbnailUrl: job.thumbnailUrl || null,
              duration: job.duration || 0,
              mode: job.mode,
              container: job.container,
              formatSelector:
                job.formatSelector ||
                (job.mode === 'audio' ? 'bestaudio/best' : 'bestvideo[height<=1080]+bestaudio/best[height<=1080]'),
              useCookies: true,
            },
          ],
        }),
      });

      if (!res.ok) {
        const info = await extractApiErrorInfo(res, 'Unable to requeue job with cookies.');
        setActionFeedback({
          kind: 'error',
          message: info.message,
          needsCookieSetup: info.code === 'COOKIE_NOT_FOUND',
        });
        return;
      }

      setActionFeedback({
        kind: 'info',
        message: `Requeued "${job.title}" with saved cookies enabled.`,
      });
      await refresh();
    } catch {
      setActionFeedback({
        kind: 'error',
        message: 'Network error while retrying job with cookies.',
      });
    } finally {
      setRetryingJobId(null);
    }
  }

  const pollDotClass = isPolling
    ? 'bg-ready-dot'
    : isTabHidden && activeCount > 0
      ? 'bg-muxing-dot'
      : 'bg-border-strong';

  const pollStatusLabel = isPolling
    ? 'BullMQ worker · Polling every 2.5s'
    : isTabHidden && activeCount > 0
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

          <button
            type="button"
            disabled={clearingExpired || historyJobs.length === 0}
            onClick={handleClearExpired}
            data-testid="clear-expired-btn"
            className="mv-focus inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border-default bg-surface-elevated px-3 text-[13px] font-medium text-ink-secondary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary disabled:cursor-not-allowed disabled:opacity-45 sm:h-8"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Clear Expired</span>
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
            {primaryJobs.length === 0
              ? 'No active or completed jobs yet'
              : `No ${filter} jobs`}
          </h2>
          <p className="max-w-sm text-[13px] text-ink-secondary">
            {primaryJobs.length === 0
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
                    </div>

                    <a
                      href={`/api/jobs/${encodeURIComponent(job.id)}/file`}
                      download
                      data-testid={`save-file-btn-${job.id}`}
                      className="mv-focus inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover active:bg-accent-active sm:h-8"
                    >
                      <Download className="h-4 w-4" aria-hidden="true" />
                      <span>Save File</span>
                    </a>
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

                    {job.sourceUrl && (
                      <button
                        type="button"
                        disabled={retryingJobId === job.id}
                        onClick={() => void handleRetryWithCookies(job)}
                        data-testid={`retry-cookies-btn-${job.id}`}
                        className="mv-focus inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border-default bg-surface px-3 text-[13px] font-medium text-ink-primary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong hover:bg-surface-high disabled:cursor-wait disabled:opacity-60 sm:h-8"
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
                  </div>
                )}
              </article>
            );
          })}
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
    </div>
  );
}
