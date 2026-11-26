'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import useSWR, { useSWRConfig } from 'swr';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Camera,
  CheckCircle2,
  CloudUpload,
  Globe,
  Hash,
  LogOut,
  Monitor,
  Moon,
  PlayCircle,
  RefreshCw,
  Search,
  Shield,
  Sun,
  Trash2,
  Upload,
  User,
  X,
} from 'lucide-react';
import {
  deriveCookiePlatformSlug,
  extractApiError,
  formatBytes,
  formatPlatformLabel,
  formatRelativeTime,
  type CookiePlatform,
  type CookiePlatformStatus,
  type SystemStatusInfo,
} from '@/lib/mediaTypes';
import { clearAllSwrCaches, swrJsonFetcher } from '@/lib/swrStore';

interface AuthUser {
  id: string;
  email: string;
  role: string;
}

const PRIMARY_COOKIE_PLATFORMS: readonly {
  id: CookiePlatform;
  label: string;
  icon: typeof PlayCircle;
}[] = [
  { id: 'youtube', label: 'YouTube', icon: PlayCircle },
  { id: 'instagram', label: 'Instagram', icon: Camera },
  { id: 'x', label: 'X / Twitter', icon: Hash },
  { id: 'facebook', label: 'Facebook', icon: Globe },
];

const ALL_COOKIE_PLATFORMS: readonly { id: CookiePlatform; label: string }[] = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'x', label: 'X / Twitter' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'dailymotion', label: 'Dailymotion' },
];

const MAX_COOKIE_BYTES = 512 * 1024;

const BUILT_IN_COOKIE_IDS = new Set(ALL_COOKIE_PLATFORMS.map((p) => p.id));

function getCookiePlatformLabel(platform: CookiePlatform): string {
  return (
    ALL_COOKIE_PLATFORMS.find((p) => p.id === platform)?.label ||
    formatPlatformLabel(platform)
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { cache, mutate } = useSWRConfig();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastPopoverRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastCloseBtnRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const dropzoneHeadingId = useId();
  const customSiteInputId = useId();
  const customSiteHintId = useId();
  const customSiteErrorId = useId();
  const customSiteInputRef = useRef<HTMLInputElement>(null);
  const [customSite, setCustomSite] = useState<string>('');
  const [customSiteTouched, setCustomSiteTouched] = useState<boolean>(false);
  const customSiteSlug = useMemo(() => deriveCookiePlatformSlug(customSite), [customSite]);
  const customSiteInvalid = customSiteTouched && customSite.trim().length > 0 && !customSiteSlug;
  const customSiteEmptySubmit = customSiteTouched && customSite.trim().length === 0;
  const [mounted, setMounted] = useState<boolean>(false);
  const [signingOut, setSigningOut] = useState<boolean>(false);

  const { data: meData } = useSWR<{ user?: AuthUser }>(
    '/api/auth/me',
    swrJsonFetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const {
    data: cookiesData,
    isLoading: cookiesSwrLoading,
    mutate: mutateCookies,
  } = useSWR<{ cookies?: CookiePlatformStatus[] }>('/api/cookies', swrJsonFetcher);
  const { data: systemData, mutate: mutateSystem } = useSWR<{
    system?: SystemStatusInfo;
  }>('/api/system/status', swrJsonFetcher);
  const { data: providersData } = useSWR<{
    totalExtractors?: number;
    uniqueProviders?: number;
    providers?: string[];
  }>('/api/system/providers', swrJsonFetcher, { revalidateOnFocus: false });

  const user = meData?.user ?? null;
  const cookies = useMemo(
    () => (Array.isArray(cookiesData?.cookies) ? cookiesData.cookies : []),
    [cookiesData]
  );
  const cookiesLoading = Boolean(!cookiesData && cookiesSwrLoading);
  const systemStatus = systemData?.system ?? null;

  const [providerQuery, setProviderQuery] = useState<string>('');
  const providerList = useMemo(() => {
    const all = Array.isArray(providersData?.providers) ? providersData.providers : [];
    const query = providerQuery.trim().toLowerCase();
    return query ? all.filter((name) => name.toLowerCase().includes(query)) : all;
  }, [providerQuery, providersData]);
  const visibleProviders = providerList.slice(0, 200);

  const [targetPlatform, setTargetPlatform] = useState<CookiePlatform>('youtube');
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [uploadingPlatform, setUploadingPlatform] = useState<CookiePlatform | null>(null);
  const [deletingPlatform, setDeletingPlatform] = useState<CookiePlatform | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [toastState, setToastState] = useState<{
    message: string;
    kind: 'success' | 'error';
  } | null>(null);
  const [srAnnouncement, setSrAnnouncement] = useState<string>('');
  const [toastFocused, setToastFocused] = useState<boolean>(false);

  const dismissToast = useCallback((restoreFocus = false) => {
    if (toastTimerRef.current !== null) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }

    const popoverEl = toastPopoverRef.current as
      | (HTMLDivElement & { hidePopover?: () => void })
      | null;
    if (popoverEl) {
      try {
        popoverEl.hidePopover?.();
      } catch {
        // Ignore if already closed
      }
      popoverEl.classList.remove(':popover-open');
    }

    setToastState(null);
    if (restoreFocus && previousFocusRef.current?.isConnected) {
      previousFocusRef.current.focus();
    }
  }, []);

  const showToast = useCallback(
    (message: string, kind: 'success' | 'error' = 'success') => {
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }

      if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
        previousFocusRef.current = document.activeElement;
      }

      setToastState({ message, kind });

      // Announce via ariaNotify when supported, else update pre-mounted live region
      const docWithNotify = document as Document & {
        ariaNotify?: (text: string) => void;
      };
      if (typeof docWithNotify.ariaNotify === 'function') {
        docWithNotify.ariaNotify(message);
      } else {
        setSrAnnouncement('');
        requestAnimationFrame(() => setSrAnnouncement(message));
      }

      requestAnimationFrame(() => {
        const popoverEl = toastPopoverRef.current as
          | (HTMLDivElement & { showPopover?: () => void })
          | null;
        if (popoverEl) {
          try {
            popoverEl.showPopover?.();
          } catch {
            // Fallback class when native popover API is unavailable
          }
          if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
            popoverEl.classList.add(':popover-open');
          }
        }
      });
    },
    []
  );

  // Auto-dismiss non-focused toast after 4 seconds
  useEffect(() => {
    if (!toastState || toastFocused) {
      return;
    }
    toastTimerRef.current = setTimeout(() => {
      dismissToast(false);
    }, 4000);
    return () => {
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [dismissToast, toastFocused, toastState]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cookieSiteParam = new URLSearchParams(window.location.search).get('cookieSite');
    if (cookieSiteParam && cookieSiteParam.trim()) {
      const slug = deriveCookiePlatformSlug(cookieSiteParam);
      setCustomSite(slug || cookieSiteParam.trim());
      setCustomSiteTouched(!slug);
      if (slug) {
        setTargetPlatform(slug);
      }
      const uploadSection = document.getElementById('cookie-upload');
      if (uploadSection) {
        requestAnimationFrame(() => {
          uploadSection.scrollIntoView({
            behavior: prefersReduced ? 'auto' : 'smooth',
            block: 'start',
          });
          customSiteInputRef.current?.focus({ preventScroll: true });
        });
      }
      return;
    }
    if (window.location.hash === '#cookie-upload' || window.location.hash === '#age-restricted-guide') {
      const targetId = window.location.hash.slice(1);
      const target = document.getElementById(targetId);
      if (target) {
        requestAnimationFrame(() => {
          target.scrollIntoView({
            behavior: prefersReduced ? 'auto' : 'smooth',
            block: 'start',
          });
        });
      }
    }
  }, []);

  const cookieMap = useMemo(() => {
    const map = new Map<CookiePlatform, CookiePlatformStatus>();
    for (const entry of cookies) {
      map.set(entry.platform, entry);
    }
    return map;
  }, [cookies]);

  const installedCookieCount = useMemo(
    () => cookies.filter((entry) => entry.installed).length,
    [cookies]
  );

  const customInstalledCookies = useMemo(
    () =>
      cookies
        .filter((entry) => entry.installed && !BUILT_IN_COOKIE_IDS.has(entry.platform))
        .sort((a, b) => a.platform.localeCompare(b.platform)),
    [cookies]
  );

  const extraInstalledCookies = useMemo(
    () =>
      cookies
        .filter(
          (entry) =>
            entry.installed &&
            !PRIMARY_COOKIE_PLATFORMS.some((p) => p.id === entry.platform)
        )
        .sort((a, b) => a.platform.localeCompare(b.platform)),
    [cookies]
  );

  const targetPlatformLabel = getCookiePlatformLabel(targetPlatform);

  function handleCustomSiteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCustomSiteTouched(true);
    if (!customSiteSlug) {
      customSiteInputRef.current?.focus();
      return;
    }
    triggerUploadFor(customSiteSlug);
  }

  function triggerUploadFor(platform: CookiePlatform) {
    setTargetPlatform(platform);
    setUploadError(null);
    requestAnimationFrame(() => {
      fileInputRef.current?.click();
    });
  }

  async function uploadCookieFile(file: File, platform: CookiePlatform) {
    setUploadError(null);

    if (file.size > MAX_COOKIE_BYTES) {
      setUploadError('Cookie file exceeds the 512 KB maximum limit.');
      return;
    }

    setUploadingPlatform(platform);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`/api/cookies/${encodeURIComponent(platform)}`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const msg = await extractApiError(
          res,
          `Failed to upload cookies for ${platform}.`
        );
        setUploadError(msg);
        showToast(msg, 'error');
        return;
      }

      const data = (await res.json()) as { cookieCount?: number };
      await Promise.all([mutateCookies(), mutateSystem()]);
      const label = getCookiePlatformLabel(platform);
      showToast(
        `Saved ${label} cookies.txt (${data.cookieCount ?? 0} entries, 0600)`,
        'success'
      );
    } catch {
      const msg = 'Network error uploading Netscape cookie file.';
      setUploadError(msg);
      showToast(msg, 'error');
    } finally {
      setUploadingPlatform(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void uploadCookieFile(file, targetPlatform);
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!dragActive) {
      setDragActive(true);
    }
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);

    const file = event.dataTransfer.files?.[0];
    if (file) {
      void uploadCookieFile(file, targetPlatform);
    }
  }

  function handleDropzoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInputRef.current?.click();
    }
  }

  async function handleDeleteCookie(platform: CookiePlatform) {
    if (deletingPlatform) {
      return;
    }
    setDeletingPlatform(platform);
    setUploadError(null);

    try {
      const res = await fetch(`/api/cookies/${encodeURIComponent(platform)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const msg = await extractApiError(res, `Failed to delete ${platform} cookies.`);
        setUploadError(msg);
        showToast(msg, 'error');
        return;
      }

      await Promise.all([mutateCookies(), mutateSystem()]);
      const label = getCookiePlatformLabel(platform);
      showToast(`Removed ${label} cookies.txt`, 'success');
    } catch {
      const msg = 'Network error deleting platform cookie file.';
      setUploadError(msg);
      showToast(msg, 'error');
    } finally {
      setDeletingPlatform(null);
    }
  }

  async function handleSignOut() {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST', cache: 'no-store' });
    } finally {
      await clearAllSwrCaches(cache, mutate);
      router.replace('/login');
      router.refresh();
      setSigningOut(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 md:px-6 md:py-8">
      {/* Section 1: Platform Cookies (2x2 Grid) */}
      <section aria-labelledby="platform-cookies-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <h1
              id="platform-cookies-heading"
              className="text-lg font-semibold tracking-[-0.01em] text-ink-primary"
            >
              Platform Cookies
            </h1>
            <span
              data-testid="installed-cookie-count"
              className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary"
            >
              {installedCookieCount} installed · Any site
            </span>
          </div>
          <p className="text-[13px] text-ink-secondary">
            Stored locally in Docker volume (`0600`). Attached only when explicitly toggled on.
            Need cookies for another site (Hotstar, Vimeo, Twitch...)? Use{' '}
            <a
              href="#cookie-upload"
              className="font-medium text-accent-text underline underline-offset-4"
            >
              Add cookies for any site
            </a>{' '}
            below.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="cookie-cards-grid">
          {PRIMARY_COOKIE_PLATFORMS.map((platformDef) => {
            const Icon = platformDef.icon;
            const status = cookieMap.get(platformDef.id);
            const installed = Boolean(status?.installed);
            const isValid = status?.isValid !== false;
            const isBusy =
              uploadingPlatform === platformDef.id ||
              deletingPlatform === platformDef.id;

            return (
              <div
                key={platformDef.id}
                data-testid={`cookie-card-${platformDef.id}`}
                data-installed={installed ? 'true' : 'false'}
                className={`flex flex-col justify-between gap-4 rounded-xl border p-4 shadow-[var(--shadow-xs)] transition-colors ${
                  installed
                    ? 'border-border-default bg-surface hover:border-border-strong'
                    : 'border-border-default bg-surface-elevated hover:border-border-strong'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-default bg-surface-elevated text-ink-primary">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <span className="truncate text-sm font-semibold text-ink-primary">
                      {platformDef.label}
                    </span>
                  </div>

                  {installed ? (
                    isValid ? (
                      <span className="shrink-0 rounded border border-ready-border bg-ready-bg px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider text-ready">
                        Active
                      </span>
                    ) : (
                      <span className="shrink-0 rounded border border-muxing-border bg-muxing-bg px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muxing">
                        Expired?
                      </span>
                    )
                  ) : (
                    <span className="shrink-0 rounded border border-border-default bg-surface-high px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      Not configured
                    </span>
                  )}
                </div>

                <div className="font-mono text-xs text-ink-secondary">
                  {cookiesLoading ? (
                    <span>Checking vault...</span>
                  ) : installed ? (
                    isValid ? (
                      <span>{formatRelativeTime(status?.updatedAt)}</span>
                    ) : (
                      <span className="text-muxing">Session validation failed</span>
                    )
                  ) : (
                    <span className="text-ink-muted">No cookie file attached</span>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  {installed ? (
                    <>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => triggerUploadFor(platformDef.id)}
                        data-testid={`replace-cookie-${platformDef.id}`}
                        className="mv-focus inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border-default bg-surface-elevated px-3 text-[13px] font-medium text-ink-primary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong hover:bg-surface-high disabled:opacity-50"
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Replace</span>
                      </button>

                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleDeleteCookie(platformDef.id)}
                        aria-label={`Delete ${platformDef.label} cookies`}
                        title={`Delete ${platformDef.label} cookies`}
                        data-testid={`delete-cookie-${platformDef.id}`}
                        className="mv-focus inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-border-default bg-surface-elevated text-ink-secondary shadow-[var(--shadow-xs)] transition-colors hover:border-failed-border hover:bg-failed-bg hover:text-failed disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => triggerUploadFor(platformDef.id)}
                      data-testid={`upload-cookie-${platformDef.id}`}
                      className="mv-focus inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover disabled:opacity-50"
                    >
                      <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Upload cookies.txt</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Section 2: Upload Dropzone */}
      <section
        id="cookie-upload"
        aria-labelledby={dropzoneHeadingId}
        className="scroll-mt-20 flex flex-col gap-4"
      >
        <div className="flex items-center justify-between gap-2">
          <h2
            id={dropzoneHeadingId}
            className="text-sm font-semibold text-ink-primary"
          >
            Upload Dropzone
          </h2>
          <span
            data-testid="selected-cookie-target"
            className="font-mono text-xs font-medium text-accent-text"
          >
            Target: {targetPlatformLabel} ({targetPlatform}.txt)
          </span>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,text/plain"
          onChange={handleFileInputChange}
          data-testid="cookie-file-input"
          aria-label={`Upload Netscape cookies.txt for ${targetPlatformLabel}`}
          className="hidden"
        />

        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={handleDropzoneKeyDown}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          data-testid="cookie-dropzone"
          className={`mv-focus flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-7 text-center shadow-[var(--shadow-xs)] transition-colors sm:p-8 ${
            dragActive
              ? 'border-accent bg-accent-soft'
              : 'border-border-default bg-surface-recessed hover:border-border-strong hover:bg-surface'
          }`}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-accent-border bg-accent-soft text-accent-text">
            <CloudUpload className="h-5 w-5" aria-hidden="true" />
          </div>
          <p className="text-[13px] text-ink-primary">
            {uploadingPlatform ? (
              <span>Validating &amp; saving {uploadingPlatform} cookies.txt...</span>
            ) : (
              <>
                Drop Netscape <code className="font-mono">cookies.txt</code> here or{' '}
                <span className="font-medium text-accent-text underline underline-offset-4">
                  browse
                </span>
              </>
            )}
          </p>
          <p className="font-mono text-[11px] text-ink-muted">
            Netscape HTTP Cookie File format (.txt) · Max 512 KB · Stored with 0600 permissions
          </p>
        </div>

        {uploadError && (
          <div
            role="alert"
            data-testid="cookie-upload-error"
            className="flex items-start gap-2 rounded-lg border border-failed-border bg-failed-bg px-3 py-2 text-xs text-failed"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              <strong className="font-semibold">Error:</strong> {uploadError}
            </span>
          </div>
        )}

        {/* Platform Selector Pills */}
        <div
          role="group"
          aria-label="Target cookie upload platform"
          className="flex flex-wrap items-center gap-2"
        >
          {ALL_COOKIE_PLATFORMS.map((pill) => {
            const active = targetPlatform === pill.id;
            const status = cookieMap.get(pill.id);
            return (
              <button
                key={pill.id}
                type="button"
                aria-pressed={active}
                data-testid={`platform-pill-${pill.id}`}
                onClick={() => {
                  setTargetPlatform(pill.id);
                  setUploadError(null);
                }}
                className={`mv-focus inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors ${
                  active
                    ? 'border-accent bg-accent font-semibold text-on-accent shadow-[var(--shadow-xs)]'
                    : 'border-border-default bg-surface font-medium text-ink-secondary hover:bg-surface-high hover:text-ink-primary'
                }`}
              >
                {status?.installed && (
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${
                      active ? 'bg-on-accent' : 'bg-ready-dot'
                    }`}
                  />
                )}
                <span>{pill.label}</span>
              </button>
            );
          })}

          {extraInstalledCookies
            .filter((entry) => !BUILT_IN_COOKIE_IDS.has(entry.platform))
            .map((entry) => {
              const active = targetPlatform === entry.platform;
              return (
                <button
                  key={entry.platform}
                  type="button"
                  aria-pressed={active}
                  data-testid={`platform-pill-${entry.platform}`}
                  onClick={() => {
                    setTargetPlatform(entry.platform);
                    setUploadError(null);
                  }}
                  className={`mv-focus inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors ${
                    active
                      ? 'border-accent bg-accent font-semibold text-on-accent shadow-[var(--shadow-xs)]'
                      : 'border-border-default bg-surface font-medium text-ink-secondary hover:bg-surface-high hover:text-ink-primary'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-on-accent' : 'bg-ready-dot'}`}
                  />
                  <span className="font-mono text-xs">{entry.platform}</span>
                </button>
              );
            })}

          {targetPlatform &&
            !BUILT_IN_COOKIE_IDS.has(targetPlatform) &&
            !cookieMap.get(targetPlatform)?.installed && (
              <span
                data-testid={`platform-pill-${targetPlatform}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-accent bg-accent px-3 py-1.5 font-mono text-xs font-semibold text-on-accent shadow-[var(--shadow-xs)]"
              >
                {targetPlatform}
              </span>
            )}
        </div>

        {/* Add cookies for any yt-dlp supported site */}
        <form
          onSubmit={handleCustomSiteSubmit}
          noValidate
          data-testid="custom-cookie-site-form"
          className="flex flex-col gap-2 rounded-xl border border-border-default bg-surface p-4 shadow-[var(--shadow-xs)]"
        >
          <label
            htmlFor={customSiteInputId}
            className="text-[13px] font-semibold text-ink-primary"
          >
            Add cookies for any site
          </label>
          <p id={customSiteHintId} className="text-xs leading-relaxed text-ink-secondary">
            Enter the site domain or paste the video URL that asked for cookies (for example{' '}
            <code className="font-mono text-[11px]">hotstar.com</code> or{' '}
            <code className="font-mono text-[11px]">https://www.hotstar.com/in/...</code>).
            MediaVault saves it as <code className="font-mono text-[11px]">&lt;domain&gt;.txt</code>{' '}
            and uses it automatically for every URL on that site.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              ref={customSiteInputRef}
              id={customSiteInputId}
              type="text"
              inputMode="url"
              value={customSite}
              onChange={(event) => {
                const nextValue = event.target.value;
                setCustomSite(nextValue);
                if (!nextValue.trim()) {
                  setCustomSiteTouched(false);
                } else {
                  const nextSlug = deriveCookiePlatformSlug(nextValue);
                  if (nextSlug) {
                    setTargetPlatform(nextSlug);
                  }
                }
                setUploadError(null);
              }}
              onBlur={() => {
                if (customSite.trim()) {
                  setCustomSiteTouched(true);
                }
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="go"
              placeholder="hotstar.com"
              aria-invalid={customSiteInvalid || customSiteEmptySubmit ? 'true' : 'false'}
              aria-describedby={
                customSiteInvalid || customSiteEmptySubmit
                  ? `${customSiteHintId} ${customSiteErrorId}`
                  : customSiteHintId
              }
              data-testid="custom-cookie-site-input"
              className={`mv-focus h-9 min-w-0 flex-1 rounded-lg border bg-surface-recessed px-3 font-mono text-[13px] text-ink-primary placeholder:text-ink-placeholder focus:border-accent focus:outline-none ${
                customSiteInvalid || customSiteEmptySubmit
                  ? 'border-failed-border'
                  : 'border-border-default'
              }`}
            />
            <button
              type="submit"
              disabled={Boolean(uploadingPlatform)}
              data-testid="custom-cookie-site-upload-btn"
              className="mv-focus inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {customSiteSlug ? `Upload cookies.txt for ${customSiteSlug}` : 'Upload cookies.txt'}
              </span>
            </button>
          </div>
          {(customSiteInvalid || customSiteEmptySubmit) && (
            <p
              id={customSiteErrorId}
              className="flex items-start gap-1.5 text-xs text-failed"
              data-testid="custom-cookie-site-error"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-label="Error" role="img" />
              <span>
                {customSiteEmptySubmit
                  ? 'Enter a site domain such as hotstar.com.'
                  : 'Enter a valid domain such as hotstar.com or a full https:// URL.'}
              </span>
            </p>
          )}
        </form>

        {customInstalledCookies.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="custom-cookie-list">
            <h3 className="text-xs font-semibold uppercase tracking-[0.02em] text-ink-muted">
              Saved site cookies
            </h3>
            <ul className="divide-y divide-border-subtle rounded-xl border border-border-default bg-surface shadow-[var(--shadow-xs)]">
              {customInstalledCookies.map((entry) => {
                const isBusy =
                  uploadingPlatform === entry.platform || deletingPlatform === entry.platform;
                return (
                  <li
                    key={entry.platform}
                    data-testid={`custom-cookie-row-${entry.platform}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-mono text-[13px] font-medium text-ink-primary">
                        {entry.platform}
                      </span>
                      <span className="font-mono text-[11px] text-ink-muted">
                        {entry.isValid === false
                          ? 'Session validation failed'
                          : formatRelativeTime(entry.updatedAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => triggerUploadFor(entry.platform)}
                        data-testid={`replace-cookie-${entry.platform}`}
                        className="mv-focus inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border-default bg-surface-elevated px-3 text-[13px] font-medium text-ink-primary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong hover:bg-surface-high disabled:opacity-50"
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Replace</span>
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleDeleteCookie(entry.platform)}
                        aria-label={`Delete ${entry.platform} cookies`}
                        title={`Delete ${entry.platform} cookies`}
                        data-testid={`delete-cookie-${entry.platform}`}
                        className="mv-focus inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-border-default bg-surface-elevated text-ink-secondary shadow-[var(--shadow-xs)] transition-colors hover:border-failed-border hover:bg-failed-bg hover:text-failed disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {cookieMap.get('dailymotion')?.installed && (
          <div>
            <button
              type="button"
              onClick={() => void handleDeleteCookie('dailymotion')}
              data-testid="delete-cookie-dailymotion"
              className="mv-focus inline-flex cursor-pointer items-center gap-1 rounded-full border border-failed-border bg-failed-bg px-2.5 py-1.5 font-mono text-[11px] text-failed transition-opacity hover:opacity-90"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              <span>Remove Dailymotion</span>
            </button>
          </div>
        )}
      </section>

      {/* Section 2.5: How to Access Age-Restricted Videos Guide */}
      <section
        id="age-restricted-guide"
        aria-labelledby="age-restricted-guide-heading"
        data-testid="age-restricted-guide"
        className="scroll-mt-20 flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-accent-text" aria-hidden="true" />
              <h2
                id="age-restricted-guide-heading"
                className="text-sm font-semibold text-ink-primary"
              >
                How to Access Age-Restricted Videos
              </h2>
            </div>
            <span className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-secondary">
              Step-by-Step Guide
            </span>
          </div>
          <p className="text-[13px] text-ink-secondary">
            Age-restricted, login-walled, or bot-checked videos require a logged-in browser cookie session.
          </p>
        </div>

        <div className="rounded-xl border border-border-default bg-surface p-4 shadow-[var(--shadow-xs)]">
          <ol className="flex flex-col gap-2.5">
            <li className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-elevated p-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent-border bg-accent-soft font-mono text-xs font-semibold text-accent-text">
                1
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-[13px] font-semibold text-ink-primary">
                  Sign in to the platform in your browser
                </p>
                <p className="text-xs leading-relaxed text-ink-secondary">
                  Open the site that asked for cookies (YouTube, Instagram, X, Facebook,
                  Dailymotion, Hotstar, or any other supported site) and sign into an account
                  that can view the video.
                </p>
                <p className="rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-secondary">
                  <strong className="font-semibold text-ink-primary">YouTube tip:</strong> Sign in
                  inside a fresh <strong className="font-medium text-ink-primary">Incognito / Private window</strong>,
                  export cookies, and immediately close that window so YouTube does not rotate and
                  invalidate your exported session.
                </p>
              </div>
            </li>

            <li className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-elevated p-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent-border bg-accent-soft font-mono text-xs font-semibold text-accent-text">
                2
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-[13px] font-semibold text-ink-primary">
                  Export cookies in Netscape <code className="font-mono text-xs">cookies.txt</code> format
                </p>
                <p className="text-xs leading-relaxed text-ink-secondary">
                  Use a local browser cookie exporter extension (such as{' '}
                  <span className="font-medium text-ink-primary">Get cookies.txt LOCALLY</span> for
                  Chrome/Edge or <span className="font-medium text-ink-primary">cookies.txt</span>{' '}
                  for Firefox) while on that site and save the file as{' '}
                  <code className="font-mono text-[11px]">.txt</code> (Netscape HTTP Cookie File
                  format, max 512 KB).
                </p>
              </div>
            </li>

            <li className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-elevated p-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent-border bg-accent-soft font-mono text-xs font-semibold text-accent-text">
                3
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <p className="text-[13px] font-semibold text-ink-primary">
                    Upload <code className="font-mono text-xs">cookies.txt</code> in Platform Cookies above
                  </p>
                  <p className="text-xs leading-relaxed text-ink-secondary">
                    Click <strong className="font-medium text-ink-primary">Upload cookies.txt</strong>{' '}
                    on the matching platform card above, or for any other site (e.g.{' '}
                    <code className="font-mono text-[11px]">hotstar.com</code>) type its domain in{' '}
                    <strong className="font-medium text-ink-primary">Add cookies for any site</strong>{' '}
                    and upload the file there.
                  </p>
                </div>
                <div>
                  <button
                    type="button"
                    disabled={uploadingPlatform === 'youtube'}
                    onClick={() => triggerUploadFor('youtube')}
                    data-testid="guide-upload-youtube-btn"
                    className="mv-focus inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border-default bg-surface px-3 text-xs font-medium text-ink-primary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong hover:bg-surface-high disabled:opacity-50"
                  >
                    <Upload className="h-3.5 w-3.5 text-accent-text" aria-hidden="true" />
                    <span>Upload YouTube cookies.txt</span>
                  </button>
                </div>
              </div>
            </li>

            <li className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-elevated p-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent-border bg-accent-soft font-mono text-xs font-semibold text-accent-text">
                4
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <p className="text-[13px] font-semibold text-ink-primary">
                    Enable &ldquo;Use saved cookies&rdquo; in Downloader
                  </p>
                  <p className="text-xs leading-relaxed text-ink-secondary">
                    Return to Downloader, toggle{' '}
                    <strong className="font-medium text-ink-primary">Use saved cookies</strong> on
                    below the URL field, and click{' '}
                    <strong className="font-medium text-ink-primary">Inspect</strong> (or click{' '}
                    <strong className="font-medium text-ink-primary">Retry with Cookies</strong> on
                    a failed job in Queue &amp; History).
                  </p>
                </div>
                <div>
                  <Link
                    href="/"
                    data-testid="guide-open-downloader-link"
                    className="mv-focus inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover"
                  >
                    <span>Open Downloader</span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>
              </div>
            </li>
          </ol>
        </div>

        <div className="flex flex-col gap-2">
          <details className="mv-details rounded-xl border border-border-default bg-surface shadow-[var(--shadow-xs)]">
            <summary className="px-4 py-3 text-[13px] font-medium text-ink-primary transition-colors hover:text-accent-text">
              <span>Why did my YouTube cookies expire or trigger a bot check?</span>
            </summary>
            <div className="border-t border-border-subtle px-4 py-3 text-xs leading-relaxed text-ink-secondary">
              YouTube frequently rotates authentication cookies while you keep browsing in the same
              signed-in browser profile, which invalidates older exported files. To keep cookies
              valid longer, sign in inside a fresh Incognito/Private window, export{' '}
              <code className="font-mono text-[11px]">cookies.txt</code>, close that window right
              away, and click <strong className="font-medium text-ink-primary">Replace</strong> on
              the YouTube card above.
            </div>
          </details>

          <details className="mv-details rounded-xl border border-border-default bg-surface shadow-[var(--shadow-xs)]">
            <summary className="px-4 py-3 text-[13px] font-medium text-ink-primary transition-colors hover:text-accent-text">
              <span>Are my cookies stored safely and sent on every download?</span>
            </summary>
            <div className="border-t border-border-subtle px-4 py-3 text-xs leading-relaxed text-ink-secondary">
              Cookie files stay on your self-hosted Docker volume inside{' '}
              <code className="font-mono text-[11px]">./data/cookies</code> with{' '}
              <code className="font-mono text-[11px]">0600</code> permissions. MediaVault never
              attaches them automatically — they are only passed to{' '}
              <code className="font-mono text-[11px]">yt-dlp</code> when{' '}
              <strong className="font-medium text-ink-primary">Use saved cookies</strong> or{' '}
              <strong className="font-medium text-ink-primary">Retry with Cookies</strong> is
              explicitly enabled, and you can delete any platform file at any time with the trash
              icon above.
            </div>
          </details>
        </div>
      </section>

      {/* Section 3: Self-Hosted Engine Info */}
      <section aria-labelledby="engine-info-heading" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id="engine-info-heading" className="text-sm font-semibold text-ink-primary">
            Self-Hosted Engine Info
          </h2>
          <span
            data-testid="engine-health-pill"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${
              systemStatus?.dbConnected
                ? 'border-ready-border bg-ready-bg text-ready'
                : 'border-muxing-border bg-muxing-bg text-muxing'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                systemStatus?.dbConnected ? 'bg-ready-dot' : 'bg-muxing-dot'
              }`}
            />
            <span>{systemStatus?.dbConnected ? 'Daemon Healthy' : 'Checking Daemon'}</span>
          </span>
        </div>

        <div
          data-testid="engine-info-strip"
          className="grid grid-cols-1 gap-4 rounded-xl border border-border-default bg-surface p-4 shadow-[var(--shadow-xs)] sm:grid-cols-2 lg:grid-cols-5"
        >
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.02em] text-ink-muted">
              yt-dlp version
            </span>
            <span className="font-mono text-xs font-medium tabular-nums text-ink-primary">
              {systemStatus?.ytDlpVersion || 'Loading...'}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.02em] text-ink-muted">
              Supported sites
            </span>
            <span className="font-mono text-xs font-medium tabular-nums text-ink-primary">
              {systemStatus
                ? `${(systemStatus.supportedProvidersCount || 0).toLocaleString('en-US')} providers`
                : 'Loading...'}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-ink-muted">
              {systemStatus?.supportedExtractorsCount
                ? `${systemStatus.supportedExtractorsCount.toLocaleString('en-US')} extractors`
                : ''}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.02em] text-ink-muted">
              FFmpeg status
            </span>
            <span
              className={`font-mono text-xs font-medium tabular-nums ${
                systemStatus?.ffmpegInstalled === false ? 'text-failed' : 'text-ready'
              }`}
            >
              {systemStatus
                ? systemStatus.ffmpegInstalled
                  ? 'Ready · Stream-Copy'
                  : 'Unavailable'
                : 'Checking...'}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.02em] text-ink-muted">
              {systemStatus?.downloadTtlMinutes === 0
                ? 'Downloads Storage'
                : 'Temp Storage usage'}
            </span>
            <span className="font-mono text-xs font-medium tabular-nums text-ink-primary">
              {systemStatus
                ? `${systemStatus.tempStorageBytes === 0 ? '0 B' : formatBytes(systemStatus.tempStorageBytes)} / ${
                    systemStatus.downloadTtlMinutes === 0
                      ? 'Persistent (No TTL)'
                      : `Auto-purge ${systemStatus.downloadTtlMinutes}m`
                  }`
                : 'Calculating...'}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.02em] text-ink-muted">
              Registration lock
            </span>
            <span className="font-mono text-xs tabular-nums text-ink-secondary">
              {systemStatus
                ? systemStatus.allowRegistration
                  ? 'Open — Registration Active'
                  : 'Closed — Single User Mode'
                : 'Checking...'}
            </span>
          </div>
        </div>
      </section>

      {/* Section 3.5: Supported Sites Catalog */}
      <section aria-labelledby="supported-sites-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-accent-text" aria-hidden="true" />
            <h2
              id="supported-sites-heading"
              className="text-sm font-semibold text-ink-primary"
            >
              Supported Sites
            </h2>
          </div>
          <span className="rounded border border-border-default bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary">
            {providersData?.uniqueProviders
              ? `${providersData.uniqueProviders.toLocaleString('en-US')} providers`
              : 'Loading...'}
          </span>
        </div>
        <p className="text-[13px] text-ink-secondary">
          MediaVault forwards any public URL to the bundled yt-dlp build. Search the live
          extractor catalog below, then paste a link on the Downloader page.
        </p>
        <div className="flex items-center gap-2 rounded-lg border border-border-default bg-surface-recessed px-3 py-2 transition-colors focus-within:border-accent">
          <Search className="h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />
          <label htmlFor="provider-search" className="sr-only">
            Search supported sites
          </label>
          <input
            id="provider-search"
            type="search"
            value={providerQuery}
            onChange={(event) => setProviderQuery(event.target.value)}
            placeholder="Search 1,375+ providers (TikTok, Vimeo, SoundCloud...)"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-1 font-mono text-[13px] text-ink-primary placeholder:text-ink-placeholder focus:outline-none"
          />
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
            {providerList.length.toLocaleString('en-US')} shown
          </span>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-xl border border-border-default bg-surface shadow-[var(--shadow-xs)]">
          {visibleProviders.length > 0 ? (
            <ul className="divide-y divide-border-subtle">
              {visibleProviders.map((name) => (
                <li
                  key={name}
                  className="px-3 py-1.5 font-mono text-xs text-ink-secondary"
                >
                  {name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-6 text-center text-xs text-ink-muted">
              {providersData
                ? 'No providers match that search.'
                : 'Loading provider catalog...'}
            </p>
          )}
        </div>
        {providerList.length > visibleProviders.length && (
          <p className="font-mono text-[11px] text-ink-muted">
            Showing first {visibleProviders.length.toLocaleString('en-US')} of{' '}
            {providerList.length.toLocaleString('en-US')} matches. Refine your search to
            narrow the list.
          </p>
        )}
      </section>

      {/* Section 4: Appearance & Operator Session */}
      <section className="flex flex-col gap-4 rounded-xl border border-border-default bg-surface p-4 shadow-[var(--shadow-xs)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-default bg-surface-high font-mono text-sm font-semibold text-ink-primary">
              {user?.email ? (
                user.email.charAt(0).toUpperCase()
              ) : (
                <User className="h-4 w-4" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink-primary">
                {user?.email || 'Loading operator profile...'}
              </p>
              <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
                <Shield className="h-3 w-3 text-ready" aria-hidden="true" />
                <span className="uppercase">{user?.role || 'operator'}</span>
                <span>·</span>
                <span>HTTP-only JWT session</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            data-testid="settings-logout-button"
            className="mv-focus inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-failed-border bg-failed-bg px-3 text-[13px] font-medium text-failed transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span>{signingOut ? 'Signing Out...' : 'Sign Out'}</span>
          </button>
        </div>

        <div className="border-t border-border-subtle pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-secondary">Interface Theme</span>
            {mounted && (
              <span className="font-mono text-[11px] text-ink-muted">
                Active: {resolvedTheme}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'dark', label: 'Dark', icon: Moon },
              { id: 'light', label: 'Light', icon: Sun },
              { id: 'system', label: 'System', icon: Monitor },
            ].map((option) => {
              const Icon = option.icon;
              const active = mounted && theme === option.id;

              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setTheme(option.id)}
                  className={`mv-focus flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border text-[13px] transition-colors ${
                    active
                      ? 'border-accent bg-accent-soft font-semibold text-accent-text'
                      : 'border-border-default bg-surface-elevated font-medium text-ink-secondary hover:border-border-strong hover:text-ink-primary'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Accessible Notifications Region + Popover Toast */}
      <div role="region" aria-label="Notifications">
        <p className="sr-only">Screen reader notifications</p>
        <div aria-live="polite" className="sr-only">
          {srAnnouncement}
        </div>

        <div
          ref={toastPopoverRef}
          id="settings-toast-popover"
          {...({ popover: 'manual' } as Record<string, string>)}
          data-testid="settings-toast"
          onFocus={() => setToastFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setToastFocused(false);
            }
          }}
          className="mv-toast-popover fixed z-50 flex max-w-sm items-center gap-2.5 rounded-lg border border-border-default bg-surface-elevated px-3.5 py-2.5 font-mono text-xs text-ink-primary shadow-[var(--shadow-overlay)]"
        >
          {toastState && (
            <>
              {toastState.kind === 'error' ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-failed" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-ready" aria-hidden="true" />
              )}
              <span className="flex-1">{toastState.message}</span>
              <button
                ref={toastCloseBtnRef}
                type="button"
                aria-label="Close notification"
                {...({
                  popovertarget: 'settings-toast-popover',
                  popovertargetaction: 'hide',
                } as Record<string, string>)}
                onClick={() => dismissToast(true)}
                className="mv-focus inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-ink-muted hover:bg-surface-high hover:text-ink-primary"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
