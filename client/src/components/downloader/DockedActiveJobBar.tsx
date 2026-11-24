'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Download, X } from 'lucide-react';
import {
  ACTIVE_JOB_STATUSES,
  type JobDetail,
  type JobSummary,
} from '@/lib/mediaTypes';

interface DockedActiveJobBarProps {
  refreshTrigger: number;
  trackedJobIds: string[];
}

export function DockedActiveJobBar({
  refreshTrigger,
  trackedJobIds,
}: DockedActiveJobBarProps) {
  const [activeJobs, setActiveJobs] = useState<JobSummary[]>([]);
  const [primaryDetail, setPrimaryDetail] = useState<JobDetail | null>(null);
  const [readyJob, setReadyJob] = useState<JobSummary | null>(null);
  const [dismissedReadyId, setDismissedReadyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function pollJobs() {
      try {
        const listRes = await fetch('/api/jobs?limit=20', { cache: 'no-store' });
        if (!listRes.ok || cancelled) {
          return;
        }

        const listData = (await listRes.json()) as { jobs?: JobSummary[] };
        const allJobs = Array.isArray(listData.jobs) ? listData.jobs : [];
        const active = allJobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));

        setActiveJobs(active);

        window.dispatchEvent(
          new CustomEvent('mediavault:jobs-updated', {
            detail: { activeCount: active.length },
          })
        );

        if (active.length > 0) {
          const priorityJob =
            active.find((job) => job.status === 'downloading' || job.status === 'muxing') ||
            active[0];

          try {
            const detailRes = await fetch(
              `/api/jobs/${encodeURIComponent(priorityJob.id)}`,
              { cache: 'no-store' }
            );
            if (detailRes.ok && !cancelled) {
              const detailData = (await detailRes.json()) as JobDetail;
              setPrimaryDetail(detailData);
            }
          } catch {
            // Keep list summary fallback on transient detail polling failure
          }

          setReadyJob(null);
          if (!cancelled) {
            pollTimer = setTimeout(pollJobs, 2500);
          }
          return;
        }

        setPrimaryDetail(null);

        if (trackedJobIds.length > 0) {
          const trackedSet = new Set(trackedJobIds);
          const finishedReady = allJobs.find(
            (job) =>
              trackedSet.has(job.id) &&
              job.status === 'ready' &&
              job.id !== dismissedReadyId
          );
          setReadyJob(finishedReady || null);
        }
      } catch {
        if (!cancelled) {
          pollTimer = setTimeout(pollJobs, 5000);
        }
      }
    }

    void pollJobs();

    return () => {
      cancelled = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
  }, [refreshTrigger, trackedJobIds, dismissedReadyId]);

  if (activeJobs.length === 0 && !readyJob) {
    return null;
  }

  if (activeJobs.length === 0 && readyJob) {
    return (
      <aside
        aria-label="Completed download ready"
        data-testid="docked-job-bar"
        className="flex w-full flex-col justify-between gap-2.5 rounded-xl border border-ready-border bg-surface p-3 shadow-[var(--shadow-dock)] sm:flex-row sm:items-center sm:px-4"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-ready" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-ink-primary">
              {readyJob.fileName || readyJob.title}
            </p>
            <p className="font-mono text-[11px] text-ready">
              Ready for download · {readyJob.container.toUpperCase()}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <a
            href={`/api/jobs/${encodeURIComponent(readyJob.id)}/file`}
            download
            className="mv-focus inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-hover"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Save File</span>
          </a>
          <Link
            href="/queue"
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-border-default bg-surface-elevated px-2.5 text-xs font-medium text-accent-text transition-colors hover:border-border-strong"
          >
            <span>Queue</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={() => setDismissedReadyId(readyJob.id)}
            aria-label="Dismiss completed notification"
            className="mv-focus inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-muted hover:bg-surface-high hover:text-ink-primary"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </aside>
    );
  }

  const displayJob = primaryDetail || activeJobs[0];
  const progressValue = Math.min(
    100,
    Math.max(0, Math.round(displayJob.progress || 0))
  );
  const statusLabel =
    displayJob.status === 'muxing'
      ? 'Muxing'
      : displayJob.status === 'downloading'
        ? 'Downloading'
        : 'Queued';

  return (
    <aside
      aria-label="Active background download"
      data-testid="docked-job-bar"
      className="flex w-full flex-col justify-between gap-2.5 rounded-xl border border-border-default bg-surface p-3 shadow-[var(--shadow-dock)] sm:flex-row sm:items-center sm:px-4"
    >
      {/* Left: Indicator + Title */}
      <div className="flex min-w-0 items-center gap-2.5 sm:max-w-[38%]">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muxing-dot opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-muxing-dot" />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="hidden text-xs text-ink-muted sm:inline">Active Job:</span>
          <span className="truncate text-[13px] font-semibold text-ink-primary">
            {displayJob.title}
          </span>
        </div>
      </div>

      {/* Center: Status + Progress + Speed */}
      <div className="flex flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex items-center justify-between gap-2 sm:justify-start">
          <span className="font-mono text-[11px] font-medium tabular-nums text-muxing">
            {statusLabel} · {progressValue}%
          </span>
          {primaryDetail?.downloadSpeed && (
            <span className="font-mono text-[11px] tabular-nums text-ink-muted sm:hidden">
              {primaryDetail.downloadSpeed}
            </span>
          )}
        </div>

        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-highest sm:max-w-44">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${progressValue}%` }}
          />
        </div>

        {primaryDetail?.downloadSpeed && (
          <span className="hidden whitespace-nowrap font-mono text-[11px] tabular-nums text-ink-muted sm:inline">
            {primaryDetail.downloadSpeed}
            {primaryDetail.eta ? ` · ETA ${primaryDetail.eta}` : ''}
          </span>
        )}
      </div>

      {/* Right: Queue Link */}
      <div className="flex items-center justify-end">
        <Link
          href="/queue"
          className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs font-medium tabular-nums text-accent-text hover:underline"
        >
          <span>
            View Queue ({activeJobs.length})
          </span>
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
    </aside>
  );
}
