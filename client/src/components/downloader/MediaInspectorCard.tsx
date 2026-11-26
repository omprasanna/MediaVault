'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Download,
  Headphones,
  Loader2,
  Play,
  ShieldCheck,
  Video,
  Zap,
} from 'lucide-react';
import {
  extractApiError,
  formatBytes,
  formatDuration,
  formatPlatformLabel,
  type InspectFormat,
  type MediaMode,
  type SingleInspectResult,
} from '@/lib/mediaTypes';

interface MediaInspectorCardProps {
  media: SingleInspectResult;
  sourceUrl: string;
  useCookies: boolean;
  inspectLatencyMs: number | null;
  mode?: MediaMode | null;
  onModeChange?: (mode: MediaMode) => void;
  selectedFormatId?: string | null;
  onSelectedFormatIdChange?: (formatId: string) => void;
  onJobQueued: (jobIds: string[]) => void;
}

function getFormatHeadline(fmt: InspectFormat): string {
  if (fmt.mode === 'audio') {
    return 'MP3 Audio (320kbps)';
  }
  const res = fmt.height ? `${fmt.height}p` : 'Auto';
  const codecTag =
    fmt.container === 'mp4'
      ? 'MP4 (H.264)'
      : fmt.container === 'webm'
        ? `WebM (${fmt.vcodec ? fmt.vcodec.toUpperCase() : 'VP9'})`
        : 'MKV (Stream-Copy)';
  return `${res} · ${codecTag}`;
}

function getFormatSubspec(fmt: InspectFormat): string {
  if (fmt.mode === 'audio') {
    return 'FFmpeg 320kbps MP3 extraction';
  }
  if (fmt.delivery === 'direct') {
    return 'Pre-muxed progressive HTTP';
  }
  const vCodec = fmt.vcodec ? fmt.vcodec.toUpperCase() : 'AUTO';
  const aCodec = fmt.acodec ? fmt.acodec.toUpperCase() : 'AUDIO';
  const fpsSuffix = fmt.fps ? ` · ${fmt.fps}fps` : '';
  return `${vCodec} / ${aCodec}${fpsSuffix}`;
}

function getPrimaryActionLabel(fmt: InspectFormat | undefined): string {
  if (!fmt) return 'Download';
  if (fmt.mode === 'audio') return 'Extract MP3 Audio';
  const resPrefix = fmt.height ? `${fmt.height}p ` : '';
  if (fmt.delivery === 'direct') {
    return `Instant Stream ${resPrefix}${fmt.container.toUpperCase()}`;
  }
  return `Download ${resPrefix}${fmt.container.toUpperCase()}`;
}

export function MediaInspectorCard({
  media,
  sourceUrl,
  useCookies,
  inspectLatencyMs,
  mode: controlledMode,
  onModeChange,
  selectedFormatId: controlledFormatId,
  onSelectedFormatIdChange,
  onJobQueued,
}: MediaInspectorCardProps) {
  const videoTabRef = useRef<HTMLButtonElement>(null);
  const audioTabRef = useRef<HTMLButtonElement>(null);

  const videoTabId = useId();
  const audioTabId = useId();
  const radioGroupName = useId();

  const videoFormats = useMemo(
    () => media.formats.filter((fmt) => fmt.mode === 'video'),
    [media.formats]
  );
  const audioFormats = useMemo(
    () => media.formats.filter((fmt) => fmt.mode === 'audio'),
    [media.formats]
  );

  const fallbackMode: MediaMode = videoFormats.length > 0 ? 'video' : 'audio';
  const isModeControlled = onModeChange !== undefined;
  const isFormatControlled = onSelectedFormatIdChange !== undefined;

  const [localMode, setLocalMode] = useState<MediaMode>(fallbackMode);
  const [localFormatId, setLocalFormatId] = useState<string>('');
  const [imgFailed, setImgFailed] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<{
    type: 'direct' | 'worker';
    message: string;
    proxyUrl?: string;
  } | null>(null);

  // Reset transient card state (and local uncontrolled selections) when a new inspection arrives
  useEffect(() => {
    if (!isModeControlled) {
      setLocalMode(fallbackMode);
    }
    if (!isFormatControlled) {
      const initialPool = fallbackMode === 'video' ? videoFormats : audioFormats;
      setLocalFormatId(initialPool[0]?.formatId || '');
    }
    setImgFailed(false);
    setActionError(null);
    setActionSuccess(null);
  }, [audioFormats, fallbackMode, isFormatControlled, isModeControlled, media, videoFormats]);

  const requestedMode = isModeControlled ? controlledMode ?? fallbackMode : localMode;
  const mode: MediaMode =
    requestedMode === 'video' && videoFormats.length === 0 && audioFormats.length > 0
      ? 'audio'
      : requestedMode === 'audio' && audioFormats.length === 0 && videoFormats.length > 0
        ? 'video'
        : requestedMode;

  const activeFormats = mode === 'video' ? videoFormats : audioFormats;
  const resolvedFormatId = isFormatControlled
    ? controlledFormatId || ''
    : localFormatId;
  const selectedFormat =
    activeFormats.find((fmt) => fmt.formatId === resolvedFormatId) || activeFormats[0];

  function updateSelectedFormat(formatId: string) {
    if (onSelectedFormatIdChange) {
      onSelectedFormatIdChange(formatId);
    } else {
      setLocalFormatId(formatId);
    }
  }

  function handleModeChange(nextMode: MediaMode, moveFocus = false) {
    if (onModeChange) {
      onModeChange(nextMode);
    } else {
      setLocalMode(nextMode);
    }
    setActionError(null);
    setActionSuccess(null);
    const nextPool = nextMode === 'video' ? videoFormats : audioFormats;
    updateSelectedFormat(nextPool[0]?.formatId || '');
    if (moveFocus) {
      if (nextMode === 'video') {
        videoTabRef.current?.focus();
      } else {
        audioTabRef.current?.focus();
      }
    }
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      if (mode === 'video' && audioFormats.length > 0) {
        handleModeChange('audio', true);
      } else if (mode === 'audio' && videoFormats.length > 0) {
        handleModeChange('video', true);
      }
    } else if (event.key === 'Home' && videoFormats.length > 0) {
      event.preventDefault();
      handleModeChange('video', true);
    } else if (event.key === 'End' && audioFormats.length > 0) {
      event.preventDefault();
      handleModeChange('audio', true);
    }
  }

  async function handleDownloadClick() {
    if (!selectedFormat || submitting) {
      return;
    }

    setActionError(null);
    setActionSuccess(null);

    // Fast Path: Instant Stream direct proxy download without queuing a worker job
    if (selectedFormat.delivery === 'direct' && selectedFormat.proxyUrl) {
      const anchor = document.createElement('a');
      anchor.href = selectedFormat.proxyUrl;
      anchor.setAttribute('download', '');
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      setActionSuccess({
        type: 'direct',
        message: 'Instant Stream started via /api/proxy with no server buffering.',
        proxyUrl: selectedFormat.proxyUrl,
      });
      return;
    }

    // Worker Path: Async 1080p stream-copy muxing or MP3 extraction
    setSubmitting(true);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceUrl,
          useCookies,
          items: [
            {
              sourceUrl,
              title: media.title,
              thumbnailUrl: media.thumbnail,
              duration: media.duration,
              mode: selectedFormat.mode,
              container: selectedFormat.container,
              formatSelector: selectedFormat.formatSelector,
              estimatedSizeBytes: selectedFormat.filesize,
              useCookies,
            },
          ],
        }),
      });

      if (!res.ok) {
        const msg = await extractApiError(res, 'Failed to enqueue download job.');
        setActionError(msg);
        return;
      }

      const data = (await res.json()) as { jobIds?: string[] };
      const jobIds = Array.isArray(data.jobIds) ? data.jobIds : [];
      onJobQueued(jobIds);
      setActionSuccess({
        type: 'worker',
        message:
          selectedFormat.mode === 'audio'
            ? 'Queued MP3 extraction job in worker pipeline.'
            : `Queued lossless ${selectedFormat.container.toUpperCase()} stream-copy mux job.`,
      });
    } catch {
      setActionError('Network error submitting job to MediaVault API.');
    } finally {
      setSubmitting(false);
    }
  }

  const maxHeight = videoFormats.reduce(
    (max, fmt) => (fmt.height && fmt.height > max ? fmt.height : max),
    0
  );
  const maxFps = videoFormats.reduce(
    (max, fmt) => (fmt.fps && fmt.fps > max ? fmt.fps : max),
    0
  );
  const hasDirectOption = videoFormats.some((fmt) => fmt.delivery === 'direct');
  const ctaLabel = getPrimaryActionLabel(selectedFormat);

  return (
    <>
      <section
        aria-label="Inspected media result"
        data-testid="media-inspector-card"
        className="flex flex-col overflow-hidden rounded-xl border border-border-default bg-surface shadow-[var(--shadow-xs)]"
      >
        {/* Top Metadata Header */}
        <div className="flex flex-col items-start gap-4 border-b border-border-subtle bg-surface-elevated p-4 sm:p-5 md:flex-row">
          {/* Preview Thumbnail */}
          <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-lg border border-border-default bg-surface-recessed md:h-[118px] md:w-[210px]">
            {media.thumbnail && !imgFailed ? (
              <img
                src={media.thumbnail}
                alt={media.title}
                fetchPriority="high"
                referrerPolicy="no-referrer"
                width={210}
                height={118}
                onError={() => setImgFailed(true)}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="auth-dot-grid relative flex h-full w-full items-center justify-center bg-surface-recessed">
                <div className="flex h-11 w-11 items-center justify-center rounded-full border border-accent-border bg-surface text-accent-text">
                  <Play className="ml-0.5 h-5 w-5" aria-hidden="true" />
                </div>
              </div>
            )}

            {media.duration > 0 && (
              <span className="absolute right-2 bottom-2 rounded border border-border-subtle bg-surface-recessed/90 px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-ready">
                {formatDuration(media.duration)}
              </span>
            )}
          </div>

          {/* Title, Platform & Telemetry Tags */}
          <div className="flex min-w-0 flex-1 flex-col justify-between self-stretch">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-failed-border bg-failed-bg px-2 py-0.5 font-mono text-[11px] font-medium text-failed">
                    <span className="h-1.5 w-1.5 rounded-full bg-failed-dot" />
                    <span>{formatPlatformLabel(media.platform, sourceUrl)}</span>
                  </span>
                  <span className="rounded-full border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] font-medium text-ink-secondary">
                    {useCookies ? 'Cookie Auth' : 'Public Stream'}
                  </span>
                </div>

                {inspectLatencyMs !== null && (
                  <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-ink-muted">
                    <Zap className="h-3 w-3 text-accent-text" aria-hidden="true" />
                    <span>Fetched in {inspectLatencyMs}ms</span>
                  </span>
                )}
              </div>

              <h1
                data-testid="inspected-media-title"
                className="mt-2 line-clamp-2 text-base font-semibold leading-snug tracking-[-0.005em] text-ink-primary sm:text-[15px]"
              >
                {media.title}
              </h1>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {maxHeight > 0 && (
                <span className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary">
                  Max {maxHeight}p
                </span>
              )}
              {maxFps > 0 && (
                <span className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary">
                  {maxFps} FPS
                </span>
              )}
              {hasDirectOption && (
                <span className="rounded border border-ready-border bg-ready-bg px-2 py-0.5 font-mono text-[11px] text-ready">
                  Instant Stream Available
                </span>
              )}
              <span className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
                {media.formats.length} formats
              </span>
            </div>
          </div>
        </div>

        {/* Mode Switcher Bar (Accessible Tablist) */}
        <div className="flex flex-col gap-3 px-4 pt-4 pb-2 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.02em] text-ink-muted">
            Extraction Format
          </span>

          <div
            role="tablist"
            aria-label="Extraction format mode"
            className="grid w-full grid-cols-2 rounded-lg border border-border-default bg-surface-recessed p-1 sm:inline-grid sm:w-auto"
          >
            <button
              ref={videoTabRef}
              id={videoTabId}
              type="button"
              role="tab"
              aria-selected={mode === 'video'}
              tabIndex={mode === 'video' ? 0 : -1}
              disabled={videoFormats.length === 0}
              onClick={() => handleModeChange('video')}
              onKeyDown={handleTabKeyDown}
              data-testid="mode-tab-video"
              className={`mv-tab mv-focus inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 ${
                mode === 'video'
                  ? 'border-border-default bg-surface-elevated font-semibold text-ink-primary shadow-[var(--shadow-xs)]'
                  : 'border-transparent font-medium text-ink-secondary hover:text-ink-primary'
              }`}
            >
              <Video className="h-4 w-4 text-accent-text" aria-hidden="true" />
              <span>Video (≤1080p)</span>
            </button>

            <button
              ref={audioTabRef}
              id={audioTabId}
              type="button"
              role="tab"
              aria-selected={mode === 'audio'}
              tabIndex={mode === 'audio' ? 0 : -1}
              disabled={audioFormats.length === 0}
              onClick={() => handleModeChange('audio')}
              onKeyDown={handleTabKeyDown}
              data-testid="mode-tab-audio"
              className={`mv-tab mv-focus inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 ${
                mode === 'audio'
                  ? 'border-border-default bg-surface-elevated font-semibold text-ink-primary shadow-[var(--shadow-xs)]'
                  : 'border-transparent font-medium text-ink-secondary hover:text-ink-primary'
              }`}
            >
              <Headphones className="h-4 w-4 text-accent-text" aria-hidden="true" />
              <span>Audio (MP3)</span>
            </button>
          </div>
        </div>

        {/* Format Selection Grid Panel */}
        <div
          role="tabpanel"
          aria-labelledby={mode === 'video' ? videoTabId : audioTabId}
          className="px-4 pt-2 pb-4 sm:px-5 sm:pb-5"
        >
          <fieldset>
            <legend className="sr-only">
              Available {mode === 'video' ? 'video' : 'audio'} formats
            </legend>

            {activeFormats.length === 0 ? (
              <p className="rounded-lg border border-border-default bg-surface-recessed px-4 py-6 text-center text-[13px] text-ink-muted">
                No {mode} formats returned for this media URL.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {activeFormats.map((fmt) => {
                  const isSelected = selectedFormat?.formatId === fmt.formatId;
                  const isDirect = fmt.delivery === 'direct';

                  return (
                    <label
                      key={fmt.formatId}
                      data-testid={`format-card-${fmt.formatId}`}
                      data-delivery={fmt.delivery}
                      className={`mv-focus relative flex cursor-pointer flex-col justify-between rounded-lg p-3.5 transition-colors ${
                        isSelected
                          ? 'border-2 border-accent bg-accent-soft shadow-[var(--shadow-xs)]'
                          : 'border border-border-default bg-surface-recessed hover:border-border-strong'
                      }`}
                    >
                      <input
                        type="radio"
                        name={radioGroupName}
                        value={fmt.formatId}
                        checked={isSelected}
                        onChange={() => {
                          updateSelectedFormat(fmt.formatId);
                          setActionError(null);
                          setActionSuccess(null);
                        }}
                        className="sr-only"
                      />

                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                              isSelected
                                ? 'border-accent bg-accent'
                                : 'border-border-strong bg-surface-recessed'
                            }`}
                          >
                            {isSelected && (
                              <span className="h-1.5 w-1.5 rounded-full bg-on-accent" />
                            )}
                          </span>
                          <span className="truncate text-sm font-semibold text-ink-primary">
                            {getFormatHeadline(fmt)}
                          </span>
                        </div>

                        <span
                          className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[11px] font-medium ${
                            isDirect
                              ? 'border-ready-border bg-ready-bg text-ready'
                              : 'border-border-default bg-surface-high text-ink-secondary'
                          }`}
                        >
                          {isDirect
                            ? 'Instant Stream'
                            : fmt.mode === 'audio'
                              ? 'MP3 Extract'
                              : 'Fast Mux'}
                        </span>
                      </div>

                      <div
                        className={`mt-3 flex items-center justify-between gap-2 border-t pt-2 font-mono text-[11px] ${
                          isSelected ? 'border-accent-border' : 'border-border-subtle'
                        }`}
                      >
                        <span className="truncate text-ink-muted">{getFormatSubspec(fmt)}</span>
                        <span className="shrink-0 font-medium tabular-nums text-ink-primary">
                          {formatBytes(fmt.filesize)}
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          {/* Status Feedback Banners */}
          {actionError && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-lg border border-failed-border bg-failed-bg px-3 py-2 text-xs text-failed"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                <strong className="font-semibold">Error:</strong> {actionError}
              </span>
            </div>
          )}

          {actionSuccess && (
            <div
              role="status"
              data-testid="download-feedback"
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ready-border bg-ready-bg px-3 py-2 text-xs text-ready"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{actionSuccess.message}</span>
              </div>

              {actionSuccess.type === 'direct' && actionSuccess.proxyUrl ? (
                <a
                  href={actionSuccess.proxyUrl}
                  download
                  className="inline-flex items-center gap-1 font-mono font-semibold underline"
                >
                  <span>Retry direct stream</span>
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              ) : (
                <Link
                  href="/queue"
                  className="inline-flex items-center gap-1 font-semibold underline"
                >
                  <span>View in Queue</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              )}
            </div>
          )}
        </div>

        {/* Card Footer (Desktop Action + Stream-Copy Guarantee) */}
        <div className="flex flex-col items-start justify-between gap-3 border-t border-border-subtle bg-surface-elevated px-4 py-3 sm:px-5 md:flex-row md:items-center">
          <div className="flex items-center gap-2 text-xs text-ink-secondary">
            <ShieldCheck className="h-4 w-4 shrink-0 text-ready" aria-hidden="true" />
            <span>
              {mode === 'audio'
                ? 'Audio extraction · Best source audio encoded to 320kbps MP3'
                : 'Zero re-encoding · Stream-copy enabled (lossless quality preservation)'}
            </span>
          </div>

          <button
            type="button"
            disabled={!selectedFormat || submitting}
            onClick={handleDownloadClick}
            data-testid="primary-download-btn"
            className="mv-focus hidden h-9 cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent px-5 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-wait disabled:opacity-70 md:inline-flex"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Queueing...</span>
              </>
            ) : (
              <>
                <Download className="h-4 w-4" aria-hidden="true" />
                <span>{ctaLabel}</span>
              </>
            )}
          </button>
        </div>
      </section>

      {/* Mobile Sticky Primary Download CTA (above fixed bottom tab bar) */}
      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px))] z-40 border-t border-border-subtle bg-canvas/95 px-4 py-2.5 backdrop-blur-xl md:hidden">
        <button
          type="button"
          disabled={!selectedFormat || submitting}
          onClick={handleDownloadClick}
          data-testid="mobile-download-btn"
          className="mv-focus flex h-[50px] w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-wait disabled:opacity-70"
        >
          {submitting ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              <span>Queueing...</span>
            </>
          ) : (
            <>
              <Download className="h-5 w-5" aria-hidden="true" />
              <span>{ctaLabel}</span>
            </>
          )}
        </button>
      </div>
    </>
  );
}
