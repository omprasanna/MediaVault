'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CloudDownload,
  Film,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import {
  PLAYLIST_FORMAT_PRESETS,
  extractApiError,
  formatDuration,
  formatPlatformLabel,
  formatTotalDuration,
  type PlaylistInspectResult,
} from '@/lib/mediaTypes';

interface PlaylistPickerProps {
  playlist: PlaylistInspectResult;
  useCookies: boolean;
  presetId?: string | null;
  onPresetChange?: (presetId: string) => void;
  selectedIds?: string[] | null;
  onSelectedIdsChange?: (ids: string[]) => void;
  onBatchQueued: (jobIds: string[], batchId: string | null) => void;
}

const INITIAL_VISIBLE_COUNT = 50;
const VISIBLE_STEP = 100;

export function PlaylistPicker({
  playlist,
  useCookies,
  presetId: controlledPresetId,
  onPresetChange,
  selectedIds: controlledSelectedIds,
  onSelectedIdsChange,
  onBatchQueued,
}: PlaylistPickerProps) {
  const defaultPresetId = /music\.youtube\.com/i.test(playlist.playlistUrl)
    ? 'mp3-320'
    : 'mp4-1080';
  const isPresetControlled = onPresetChange !== undefined;
  const isSelectionControlled = onSelectedIdsChange !== undefined;

  const formatSelectId = useId();
  const [failedThumbIds, setFailedThumbIds] = useState<Set<string>>(() => new Set());
  const [localSelectedIds, setLocalSelectedIds] = useState<Set<string>>(
    () => new Set(playlist.items.map((item) => item.id))
  );
  const [localPresetId, setLocalPresetId] = useState<string>(defaultPresetId);
  const [visibleCount, setVisibleCount] = useState<number>(INITIAL_VISIBLE_COUNT);
  const [queuing, setQueuing] = useState<boolean>(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueSuccess, setQueueSuccess] = useState<{
    count: number;
    batchId: string | null;
  } | null>(null);

  useEffect(() => {
    if (!isSelectionControlled) {
      setLocalSelectedIds(new Set(playlist.items.map((item) => item.id)));
    }
    if (!isPresetControlled) {
      setLocalPresetId(
        /music\.youtube\.com/i.test(playlist.playlistUrl) ? 'mp3-320' : 'mp4-1080'
      );
    }
    setVisibleCount(INITIAL_VISIBLE_COUNT);
    setFailedThumbIds(new Set());
    setQueueError(null);
    setQueueSuccess(null);
  }, [isPresetControlled, isSelectionControlled, playlist]);

  const rawPresetId = isPresetControlled
    ? controlledPresetId || defaultPresetId
    : localPresetId;

  const activePreset = useMemo(
    () =>
      PLAYLIST_FORMAT_PRESETS.find((preset) => preset.id === rawPresetId) ||
      PLAYLIST_FORMAT_PRESETS.find((preset) => preset.id === defaultPresetId) ||
      PLAYLIST_FORMAT_PRESETS[0],
    [defaultPresetId, rawPresetId]
  );

  const effectivePresetId = activePreset.id;

  const selectedIdsSet = useMemo(
    () =>
      isSelectionControlled
        ? new Set(controlledSelectedIds ?? playlist.items.map((item) => item.id))
        : localSelectedIds,
    [controlledSelectedIds, isSelectionControlled, localSelectedIds, playlist.items]
  );

  const groupedPresets = useMemo(() => {
    const groups = new Map<string, Array<(typeof PLAYLIST_FORMAT_PRESETS)[number]>>();
    for (const preset of PLAYLIST_FORMAT_PRESETS) {
      const bucket = groups.get(preset.group);
      if (bucket) {
        bucket.push(preset);
      } else {
        groups.set(preset.group, [preset]);
      }
    }
    return Array.from(groups.entries());
  }, []);

  const totalDurationSeconds = useMemo(
    () => playlist.items.reduce((sum, item) => sum + (Number(item.duration) || 0), 0),
    [playlist.items]
  );

  const selectedItems = useMemo(
    () => playlist.items.filter((item) => selectedIdsSet.has(item.id)),
    [playlist.items, selectedIdsSet]
  );

  const selectedCount = selectedItems.length;
  const visibleItems = playlist.items.slice(0, visibleCount);
  const hiddenCount = Math.max(0, playlist.items.length - visibleItems.length);

  function updateSelection(next: Set<string>) {
    setQueueSuccess(null);
    setQueueError(null);
    if (onSelectedIdsChange) {
      onSelectedIdsChange(Array.from(next));
    } else {
      setLocalSelectedIds(next);
    }
  }

  function handleSelectAll() {
    updateSelection(new Set(playlist.items.map((item) => item.id)));
  }

  function handleDeselectAll() {
    updateSelection(new Set());
  }

  function handleInvertSelection() {
    const next = new Set<string>();
    for (const item of playlist.items) {
      if (!selectedIdsSet.has(item.id)) {
        next.add(item.id);
      }
    }
    updateSelection(next);
  }

  function handleToggleItem(itemId: string) {
    const next = new Set(selectedIdsSet);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
    }
    updateSelection(next);
  }

  async function handleQueueBatch() {
    if (queuing || selectedCount === 0) {
      return;
    }

    setQueuing(true);
    setQueueError(null);
    setQueueSuccess(null);

    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playlistTitle: playlist.playlistTitle,
          playlistUrl: playlist.playlistUrl,
          useCookies,
          format: {
            mode: activePreset.mode,
            container: activePreset.container,
            formatSelector: activePreset.formatSelector,
          },
          items: selectedItems.map((item) => ({
            sourceUrl: item.url,
            title: item.title,
            thumbnailUrl: item.thumbnail,
            duration: item.duration,
            mode: activePreset.mode,
            container: activePreset.container,
            formatSelector: activePreset.formatSelector,
            useCookies,
          })),
        }),
      });

      if (!res.ok) {
        const msg = await extractApiError(res, 'Failed to enqueue playlist batch.');
        setQueueError(msg);
        return;
      }

      const data = (await res.json()) as {
        batchId?: string | null;
        jobIds?: string[];
      };
      const jobIds = Array.isArray(data.jobIds) ? data.jobIds : [];
      const batchId = data.batchId || null;

      onBatchQueued(jobIds, batchId);
      setQueueSuccess({ count: jobIds.length || selectedCount, batchId });
    } catch {
      setQueueError('Network error dispatching playlist batch.');
    } finally {
      setQueuing(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4" data-testid="playlist-picker">
        {/* 1. Playlist Header Card */}
        <section className="flex flex-col justify-between gap-4 rounded-xl border border-border-default bg-surface p-4 shadow-[var(--shadow-xs)] md:flex-row md:items-center md:p-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded border border-failed-border bg-failed-bg px-2 py-0.5 font-mono text-[11px] font-semibold uppercase text-failed">
                {formatPlatformLabel(playlist.platform, playlist.playlistUrl)}
              </span>
              <h1
                data-testid="playlist-title"
                className="truncate text-lg font-semibold tracking-[-0.01em] text-ink-primary"
              >
                {playlist.playlistTitle}
              </h1>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] tabular-nums text-ink-secondary">
              <span>{playlist.totalItems} items</span>
              <span>·</span>
              <span>{formatTotalDuration(totalDurationSeconds)}</span>
              <span>·</span>
              <span>{useCookies ? 'Cookie Auth' : 'Public Playlist'}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Batch Selection Quick Controls */}
            <div className="flex items-center gap-1.5 rounded-lg border border-border-default bg-surface-recessed px-2.5 py-1.5">
              <button
                type="button"
                onClick={handleSelectAll}
                data-testid="playlist-select-all"
                className="mv-focus cursor-pointer rounded px-1 py-0.5 text-xs font-medium text-accent-text transition-colors hover:bg-surface-high"
              >
                Select All
              </button>
              <span className="font-mono text-xs text-border-strong">/</span>
              <button
                type="button"
                onClick={handleInvertSelection}
                data-testid="playlist-invert"
                className="mv-focus cursor-pointer rounded px-1 py-0.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-high hover:text-ink-primary"
              >
                Invert
              </button>
              <span className="font-mono text-xs text-border-strong">/</span>
              <button
                type="button"
                onClick={handleDeselectAll}
                data-testid="playlist-deselect-all"
                className="mv-focus cursor-pointer rounded px-1 py-0.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-high hover:text-ink-primary"
              >
                Deselect
              </button>
            </div>

            {/* Shared Format Dropdown */}
            <div className="flex items-center">
              <label htmlFor={formatSelectId} className="sr-only">
                Shared download format for selected playlist items
              </label>
              <select
                id={formatSelectId}
                name="playlistFormat"
                value={effectivePresetId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  if (onPresetChange) {
                    onPresetChange(nextId);
                  } else {
                    setLocalPresetId(nextId);
                  }
                  setQueueSuccess(null);
                  setQueueError(null);
                }}
                data-testid="playlist-format-select"
                className="mv-focus h-9 cursor-pointer rounded-lg border border-border-default bg-surface-recessed px-3 font-mono text-xs text-ink-primary transition-colors hover:border-border-strong"
              >
                {groupedPresets.map(([group, presets]) => (
                  <optgroup
                    key={group}
                    label={group}
                    className="bg-surface-recessed text-ink-secondary"
                  >
                    {presets.map((preset) => (
                      <option
                        key={preset.id}
                        value={preset.id}
                        className="bg-surface-recessed text-ink-primary"
                      >
                        {preset.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Batch Status Feedback */}
        {queueError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-failed-border bg-failed-bg px-4 py-3 text-xs text-failed"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              <strong className="font-semibold">Error:</strong> {queueError}
            </span>
          </div>
        )}

        {queueSuccess && (
          <div
            role="status"
            data-testid="playlist-queue-feedback"
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ready-border bg-ready-bg px-4 py-3 text-xs text-ready"
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                Queued <strong className="tabular-nums">{queueSuccess.count}</strong> downloads (
                {activePreset.shortBadge}) into worker queue.
              </span>
            </div>
            <Link
              href="/queue"
              className="inline-flex items-center gap-1 font-semibold underline"
            >
              <span>Inspect Queue</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        )}

        {/* 2. Track List Card */}
        <section className="flex flex-col overflow-hidden rounded-xl border border-border-default bg-surface shadow-[var(--shadow-xs)]">
          {/* Table Header */}
          <div className="flex items-center justify-between border-b border-border-subtle bg-surface-recessed px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.02em] text-ink-muted sm:px-4">
            <div className="flex items-center gap-3">
              <span className="w-4 shrink-0" />
              <span className="w-6 text-center">#</span>
              <span>Track &amp; Creator</span>
            </div>
            <div className="flex items-center gap-5">
              <span className="hidden sm:inline">Target Spec</span>
              <span className="w-12 text-right">Length</span>
            </div>
          </div>

          {/* Tracks Rows */}
          {playlist.items.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-ink-muted">
              No downloadable public tracks found in this playlist.
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {visibleItems.map((item, idx) => {
                const isChecked = selectedIdsSet.has(item.id);
                const thumbFailed = failedThumbIds.has(item.id);

                return (
                  <label
                    key={item.id}
                    data-testid={`playlist-row-${idx + 1}`}
                    data-checked={isChecked ? 'true' : 'false'}
                    className={`group flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 transition-all sm:px-4 ${
                      isChecked
                        ? 'opacity-100 hover:bg-surface-high/60'
                        : 'bg-surface-recessed/30 opacity-45 hover:opacity-75'
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => handleToggleItem(item.id)}
                        className="h-4 w-4 shrink-0 cursor-pointer rounded border-border-default bg-surface-recessed"
                      />

                      <span className="w-6 shrink-0 text-center font-mono text-[11px] tabular-nums text-ink-muted">
                        {String(idx + 1).padStart(2, '0')}
                      </span>

                      <div className="relative h-9 w-14 shrink-0 overflow-hidden rounded border border-border-subtle bg-surface-highest sm:h-10 sm:w-16">
                        {item.thumbnail && !thumbFailed ? (
                          <img
                            src={item.thumbnail}
                            alt={item.title}
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            width={64}
                            height={40}
                            onError={() =>
                              setFailedThumbIds((prev) => new Set(prev).add(item.id))
                            }
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-ink-muted">
                            <Film className="h-4 w-4" aria-hidden="true" />
                          </div>
                        )}
                      </div>

                      <div className="flex min-w-0 flex-1 flex-col pr-1">
                        <span className="truncate text-[13px] font-semibold text-ink-primary transition-colors group-hover:text-accent-text sm:text-sm">
                          {item.title}
                        </span>
                        <span className="truncate font-mono text-[11px] text-ink-secondary">
                          {item.creator || formatPlatformLabel(playlist.platform)}
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-4 sm:gap-5">
                      <span className="hidden rounded border border-border-default bg-surface-elevated px-2 py-0.5 font-mono text-[11px] text-ready sm:inline-block">
                        {activePreset.shortBadge}
                      </span>
                      <span className="w-12 text-right font-mono text-xs tabular-nums text-ink-primary">
                        {item.duration > 0 ? formatDuration(item.duration) : '--:--'}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {/* Expand More Footer */}
          {hiddenCount > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-4 border-t border-border-subtle bg-surface-recessed px-3 py-2.5">
              <button
                type="button"
                onClick={() => setVisibleCount((prev) => prev + VISIBLE_STEP)}
                className="mv-focus inline-flex cursor-pointer items-center gap-1.5 font-mono text-xs text-ink-secondary transition-colors hover:text-ink-primary"
              >
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
                <span className="tabular-nums">
                  Show +{Math.min(VISIBLE_STEP, hiddenCount)} more playlist tracks
                </span>
              </button>
              {hiddenCount > VISIBLE_STEP && (
                <button
                  type="button"
                  onClick={() => setVisibleCount(playlist.items.length)}
                  className="mv-focus cursor-pointer font-mono text-xs text-accent-text hover:underline"
                >
                  Show all ({hiddenCount} remaining)
                </button>
              )}
            </div>
          )}
        </section>

        {/* Engine Spec Mini Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-default bg-surface-recessed px-3.5 py-2.5 font-mono text-[11px] text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-ready" aria-hidden="true" />
            <span>Stream-copy video capped ≤ 1080p · Full playlist batching</span>
          </span>
          <span>Worker concurrency: 2 · Saved directly to Downloads</span>
        </div>
      </div>

      {/* 3. Sticky Floating Bottom Batch Bar */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px))] z-40 px-3 pb-2 md:bottom-4 md:px-6 md:pb-0">
        <div className="pointer-events-auto mx-auto flex max-w-4xl flex-col justify-between gap-2.5 rounded-xl border border-border-default bg-surface-high/95 p-3 shadow-[var(--shadow-dock)] backdrop-blur-md sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-2">
              <span
                data-testid="playlist-selected-count"
                className="truncate text-[13px] font-semibold tabular-nums text-ink-primary"
              >
                {selectedCount} of {playlist.totalItems} items selected
              </span>
              <span className="hidden text-ink-muted sm:inline">·</span>
              <span className="truncate font-mono text-[11px] text-ink-secondary">
                Format: <strong className="text-ink-primary">{activePreset.shortBadge}</strong>
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={queuing || selectedCount === 0}
            onClick={handleQueueBatch}
            data-testid="queue-batch-btn"
            className="mv-focus inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent px-4 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:w-auto sm:shrink-0"
          >
            {queuing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Queueing Batch...</span>
              </>
            ) : (
              <>
                <CloudDownload className="h-4 w-4" aria-hidden="true" />
                <span className="tabular-nums">
                  Queue {selectedCount} Download{selectedCount === 1 ? '' : 's'}
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
}
