'use client';

import { useEffect, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  Activity,
  ArrowUpRight,
  Cpu,
  History,
  Layers,
  ListVideo,
  PlayCircle,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import { DockedActiveJobBar } from '@/components/downloader/DockedActiveJobBar';
import { MediaInspectorCard } from '@/components/downloader/MediaInspectorCard';
import { PlaylistPicker } from '@/components/downloader/PlaylistPicker';
import { UrlInputCard } from '@/components/downloader/UrlInputCard';
import {
  clearRecentInspections,
  extractApiError,
  formatPlatformLabel,
  loadRecentInspections,
  saveRecentInspection,
  type InspectResult,
  type MediaMode,
  type RecentInspectionItem,
} from '@/lib/mediaTypes';
import {
  revalidateJobsQueries,
  swrJsonFetcher,
  useDownloaderState,
} from '@/lib/swrStore';

export default function DownloaderPage() {
  const { mutate } = useSWRConfig();
  const { state, updateState, resetState } = useDownloaderState();

  const [urlInput, setUrlInput] = useState<string>(() => state.url);
  const [inspecting, setInspecting] = useState<boolean>(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [recentInspections, setRecentInspections] = useState<RecentInspectionItem[]>([]);
  const [jobsRefreshTick, setJobsRefreshTick] = useState<number>(0);

  const {
    data: healthData,
    error: healthError,
    isLoading: healthLoading,
  } = useSWR<{ status?: string }>('/api/health', swrJsonFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const daemonState: 'ready' | 'offline' | 'checking' = healthError
    ? 'offline'
    : healthData
      ? healthData.status && healthData.status !== 'ok'
        ? 'offline'
        : 'ready'
      : healthLoading
        ? 'checking'
        : 'offline';

  useEffect(() => {
    setUrlInput(state.url);
  }, [state.url]);

  useEffect(() => {
    setRecentInspections(loadRecentInspections());

    if (typeof window !== 'undefined') {
      const prefillUrl = new URLSearchParams(window.location.search).get('url');
      if (prefillUrl && prefillUrl.trim()) {
        const normalized = prefillUrl.trim();
        setUrlInput(normalized);
        updateState({ url: normalized });
      }
    }
  }, [updateState]);

  function handleUrlChange(nextUrl: string) {
    setUrlInput(nextUrl);
    updateState({ url: nextUrl });
  }

  async function runInspect(targetUrl?: string) {
    const candidate = (targetUrl ?? urlInput).trim();
    if (!candidate || inspecting) {
      return;
    }

    if (targetUrl !== undefined) {
      setUrlInput(candidate);
      updateState({ url: candidate });
    }

    setInspecting(true);
    setInspectError(null);

    const startedAt = performance.now();
    try {
      const res = await fetch('/api/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: candidate,
          useCookies: state.useCookies,
          includePlaylist: !state.singleItemOnly,
        }),
      });

      if (!res.ok) {
        const msg = await extractApiError(res, 'Failed to inspect URL metadata.');
        setInspectError(msg);
        return;
      }

      const data = (await res.json()) as InspectResult;
      const elapsed = Math.max(1, Math.round(performance.now() - startedAt));

      const defaultPlaylistPresetId = data.isPlaylist
        ? /music\.youtube\.com/i.test(data.playlistUrl)
          ? 'mp3-320'
          : 'mp4-1080'
        : null;
      const defaultPlaylistSelectedIds = data.isPlaylist
        ? data.items.map((item) => item.id)
        : null;
      const defaultSingleMode: MediaMode | null = !data.isPlaylist
        ? data.formats.some((fmt) => fmt.mode === 'video')
          ? 'video'
          : 'audio'
        : null;
      const defaultSingleFormatId: string | null =
        !data.isPlaylist && defaultSingleMode
          ? data.formats.find((fmt) => fmt.mode === defaultSingleMode)?.formatId ?? null
          : null;

      setUrlInput(candidate);
      updateState((prev) => ({
        ...prev,
        url: candidate,
        inspectResult: data,
        inspectedUrl: candidate,
        inspectLatencyMs: elapsed,
        playlistPresetId: defaultPlaylistPresetId,
        playlistSelectedIds: defaultPlaylistSelectedIds,
        singleMode: defaultSingleMode,
        singleFormatId: defaultSingleFormatId,
      }));

      const title = data.isPlaylist ? data.playlistTitle : data.title;
      const updatedRecent = saveRecentInspection({
        url: candidate,
        title,
        platform: data.platform,
        isPlaylist: data.isPlaylist,
        inspectedAt: new Date().toISOString(),
      });
      setRecentInspections(updatedRecent);
    } catch {
      setInspectError('Network error communicating with MediaVault inspector.');
    } finally {
      setInspecting(false);
    }
  }

  function handleResetToEmptyState() {
    setUrlInput('');
    setInspectError(null);
    resetState();
  }

  function handleJobsQueued(jobIds: string[]) {
    if (jobIds.length > 0) {
      updateState((prev) => ({
        ...prev,
        trackedJobIds: Array.from(new Set([...jobIds, ...prev.trackedJobIds])),
      }));
    }
    setJobsRefreshTick((prev) => prev + 1);
    void revalidateJobsQueries(mutate);
  }

  const daemonDotClass =
    daemonState === 'ready'
      ? 'bg-ready-dot'
      : daemonState === 'offline'
        ? 'bg-failed-dot'
        : 'bg-muxing-dot';

  // Active Result State (Single Video OR Playlist Batch)
  if (state.inspectResult) {
    const inspectResult = state.inspectResult;
    const containerPadding = inspectResult.isPlaylist
      ? 'pb-36 md:pb-24'
      : 'pb-24 md:pb-8';

    return (
      <div className={`mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-5 md:px-6 md:py-6 ${containerPadding}`}>
        <UrlInputCard
          variant="compact"
          url={urlInput}
          onUrlChange={handleUrlChange}
          useCookies={state.useCookies}
          onUseCookiesChange={(checked) => updateState({ useCookies: checked })}
          singleItemOnly={state.singleItemOnly}
          onSingleItemOnlyChange={(checked) => updateState({ singleItemOnly: checked })}
          loading={inspecting}
          error={inspectError}
          onClearError={() => setInspectError(null)}
          statusBadge={
            inspectResult.isPlaylist
              ? `Parsed · ${inspectResult.totalItems} tracks`
              : null
          }
          onInspect={() => runInspect()}
          onClear={handleResetToEmptyState}
        />

        {inspectResult.isPlaylist ? (
          <>
            <DockedActiveJobBar
              refreshTrigger={jobsRefreshTick}
              trackedJobIds={state.trackedJobIds}
            />
            <PlaylistPicker
              playlist={inspectResult}
              useCookies={state.useCookies}
              presetId={state.playlistPresetId}
              onPresetChange={(nextId) => updateState({ playlistPresetId: nextId })}
              selectedIds={state.playlistSelectedIds}
              onSelectedIdsChange={(ids) => updateState({ playlistSelectedIds: ids })}
              onBatchQueued={(jobIds) => handleJobsQueued(jobIds)}
            />
          </>
        ) : (
          <>
            <MediaInspectorCard
              media={inspectResult}
              sourceUrl={state.inspectedUrl}
              useCookies={state.useCookies}
              inspectLatencyMs={state.inspectLatencyMs}
              mode={state.singleMode}
              onModeChange={(nextMode) => updateState({ singleMode: nextMode })}
              selectedFormatId={state.singleFormatId}
              onSelectedFormatIdChange={(formatId) =>
                updateState({ singleFormatId: formatId })
              }
              onJobQueued={handleJobsQueued}
            />
            <DockedActiveJobBar
              refreshTrigger={jobsRefreshTick}
              trackedJobIds={state.trackedJobIds}
            />
          </>
        )}
      </div>
    );
  }

  // Exact Empty State (Before Any URL Is Inspected)
  return (
    <div
      data-testid="downloader-empty-state"
      className="relative mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-5xl flex-col items-center justify-between gap-6 px-4 py-6 md:min-h-[calc(100vh-7.5rem)] md:px-6 md:py-8"
    >
      {/* Top Telemetry Micro-Bar */}
      <div className="flex w-full items-center justify-between font-mono text-[11px] text-ink-muted">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 rounded border border-border-default bg-surface px-2 py-0.5 text-ink-secondary">
            <span className={`h-1.5 w-1.5 rounded-full ${daemonDotClass}`} />
            <span>
              {daemonState === 'ready'
                ? 'DAEMON_READY'
                : daemonState === 'offline'
                  ? 'DAEMON_OFFLINE'
                  : 'DAEMON_SYNC'}
            </span>
          </span>
          <span className="hidden text-ink-muted sm:inline">yt-dlp · node runtime</span>
        </div>

        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1 text-ink-secondary">
            <Cpu className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
            <span>FFmpeg stream-copy</span>
          </span>
          <span className="hidden text-border-strong md:inline">|</span>
          <span className="hidden items-center gap-1 text-ink-secondary md:inline-flex">
            <ShieldCheck className="h-3.5 w-3.5 text-ready" aria-hidden="true" />
            <span>Video cap: ≤ 1080p</span>
          </span>
        </div>
      </div>

      {/* Centered Hero Workspace */}
      <div className="my-auto flex w-full max-w-3xl flex-col items-center py-4">
        <div className="mb-6 flex flex-col items-center space-y-2 text-center">
          <div className="mb-1 inline-flex items-center gap-2 rounded-full border border-border-default bg-surface px-3 py-1 font-mono text-[11px] text-accent-text">
            <Activity className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
            <span>INGESTION_PIPELINE // STANDBY</span>
          </div>

          <h1 className="text-2xl font-semibold tracking-[-0.015em] text-ink-primary sm:text-[28px] sm:leading-9">
            Inspect Media Stream
          </h1>

          <p className="max-w-lg text-[13px] leading-relaxed text-ink-secondary">
            Paste a single video, track, or playlist URL to inspect stream-copy containers, direct
            HTTP streams, and batch queue targets.
          </p>
        </div>

        {/* Hero URL Input Card */}
        <UrlInputCard
          variant="hero"
          url={urlInput}
          onUrlChange={handleUrlChange}
          useCookies={state.useCookies}
          onUseCookiesChange={(checked) => updateState({ useCookies: checked })}
          singleItemOnly={state.singleItemOnly}
          onSingleItemOnlyChange={(checked) => updateState({ singleItemOnly: checked })}
          loading={inspecting}
          error={inspectError}
          onClearError={() => setInspectError(null)}
          onInspect={() => runInspect()}
          onClear={handleResetToEmptyState}
        />

        {/* Inspection Loading Skeleton */}
        {inspecting ? (
          <div
            role="status"
            aria-label="Inspecting media stream"
            className="mt-4 flex w-full flex-col gap-3 rounded-xl border border-border-default bg-surface p-4"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="aspect-video w-full animate-pulse rounded-lg bg-surface-high sm:h-[96px] sm:w-[170px]" />
              <div className="flex flex-1 flex-col gap-2">
                <div className="h-4 w-3/4 animate-pulse rounded bg-surface-high" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-surface-high" />
                <div className="mt-1 flex gap-2">
                  <div className="h-6 w-20 animate-pulse rounded bg-surface-high" />
                  <div className="h-6 w-24 animate-pulse rounded bg-surface-high" />
                </div>
              </div>
            </div>
            <p className="font-mono text-[11px] text-ink-muted">
              Probing stream manifests and container codecs via yt-dlp...
            </p>
          </div>
        ) : recentInspections.length > 0 ? (
          /* Recent Link Drafts / Inspections */
          <div className="mt-5 flex w-full flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.02em] text-ink-muted">
                <History className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Recent inspections</span>
              </span>
              <button
                type="button"
                onClick={() => setRecentInspections(clearRecentInspections())}
                className="mv-focus inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-ink-muted transition-colors hover:text-failed"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                <span>Clear recent</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {recentInspections.map((item) => (
                <button
                  key={item.url}
                  type="button"
                  onClick={() => runInspect(item.url)}
                  className="mv-focus group flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-border-default bg-surface p-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-elevated"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-subtle bg-surface-high text-accent-text">
                      {item.isPlaylist ? (
                        <ListVideo className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-ink-primary">
                        {item.title}
                      </p>
                      <p className="truncate font-mono text-[11px] text-ink-muted">
                        {formatPlatformLabel(item.platform, item.url)}
                      </p>
                    </div>
                  </div>
                  <ArrowUpRight
                    className="h-3.5 w-3.5 shrink-0 text-ink-muted transition-colors group-hover:text-accent-text"
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Clean Empty Capability Hints */
          <div className="mt-5 grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="flex items-start gap-2.5 rounded-lg border border-border-default bg-surface p-3">
              <Zap className="mt-0.5 h-4 w-4 shrink-0 text-ready" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-ink-primary">Instant Stream</p>
                <p className="mt-0.5 text-[11px] leading-snug text-ink-secondary">
                  Progressive HTTP links stream directly via{' '}
                  <code className="font-mono text-ink-primary">/api/proxy</code>.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-border-default bg-surface p-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-ink-primary">1080p Stream-Copy</p>
                <p className="mt-0.5 text-[11px] leading-snug text-ink-secondary">
                  Lossless MP4, WebM, MKV remuxing and 320kbps MP3 extraction.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-border-default bg-surface p-3">
              <Layers className="mt-0.5 h-4 w-4 shrink-0 text-muxing" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-ink-primary">Batch Playlists</p>
                <p className="mt-0.5 text-[11px] leading-snug text-ink-secondary">
                  Select tracks, pick a shared format, and enqueue entire playlists.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Operational Shortcuts Ledger */}
        <div className="mt-6 hidden flex-wrap items-center justify-center gap-4 font-mono text-[11px] text-ink-muted sm:flex">
          <span className="inline-flex items-center gap-1.5">
            <kbd className="rounded border border-border-default bg-surface px-1.5 py-0.5 text-ink-primary">
              Enter
            </kbd>
            <span>Run probe</span>
          </span>
          <span className="text-border-strong">·</span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="rounded border border-border-default bg-surface px-1.5 py-0.5 text-ink-primary">
              Esc
            </kbd>
            <span>Clear input</span>
          </span>
          <span className="text-border-strong">·</span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="rounded border border-border-default bg-surface px-1.5 py-0.5 text-ink-primary">
              Tab
            </kbd>
            <span>Cycle controls</span>
          </span>
        </div>
      </div>

      {/* Bottom Docked Active Job Bar (when background/recent jobs exist) */}
      <div className="w-full max-w-4xl">
        <DockedActiveJobBar
          refreshTrigger={jobsRefreshTick}
          trackedJobIds={state.trackedJobIds}
        />
      </div>
    </div>
  );
}
