'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import useSWR, { useSWRConfig } from 'swr';
import {
  Check,
  Copy,
  Download,
  Globe,
  Layers,
  LoaderCircle,
  LogOut,
  SlidersHorizontal,
  Square,
  User,
  X,
} from 'lucide-react';
import { clearAllSwrCaches, SwrHttpError, swrJsonFetcher } from '@/lib/swrStore';
import { MediaVaultLogo } from './MediaVaultLogo';
import { ThemeToggle } from './ThemeToggle';

interface AuthUser {
  id: string;
  email: string;
  role: string;
}

interface JobSummary {
  id: string;
  status: string;
}

interface RemoteTunnel {
  status: 'offline' | 'starting' | 'online';
  url: string | null;
}

interface AppShellProps {
  children: ReactNode;
}

const NAV_ITEMS = [
  { href: '/', desktopLabel: 'Downloader', mobileLabel: 'Downloader', icon: Download },
  { href: '/queue', desktopLabel: 'Queue & History', mobileLabel: 'Queue', icon: Layers },
  { href: '/settings', desktopLabel: 'Settings', mobileLabel: 'Settings', icon: SlidersHorizontal },
] as const;

const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'muxing']);

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { cache, mutate } = useSWRConfig();
  const isLoginRoute = pathname === '/login';

  const [signingOut, setSigningOut] = useState<boolean>(false);
  const [liveActiveCount, setLiveActiveCount] = useState<number | null>(null);
  const [remoteTunnel, setRemoteTunnel] = useState<RemoteTunnel>({
    status: 'offline',
    url: null,
  });
  const [remoteBusy, setRemoteBusy] = useState<boolean>(false);
  const [remotePanelOpen, setRemotePanelOpen] = useState<boolean>(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteCopied, setRemoteCopied] = useState<boolean>(false);

  const { data: meData, error: meError } = useSWR<{ user?: AuthUser }>(
    isLoginRoute ? null : '/api/auth/me',
    swrJsonFetcher,
    { revalidateOnFocus: true, shouldRetryOnError: false }
  );

  const {
    data: healthData,
    error: healthError,
    isLoading: healthLoading,
  } = useSWR<{ status?: string }>(
    isLoginRoute ? null : '/api/health',
    swrJsonFetcher,
    { revalidateOnFocus: true, shouldRetryOnError: false }
  );

  const { data: jobsSummaryData } = useSWR<{
    counts?: { active?: number };
    jobs?: JobSummary[];
  }>(isLoginRoute ? null : '/api/jobs?limit=1', swrJsonFetcher, {
    revalidateOnFocus: true,
  });

  useEffect(() => {
    if (
      !isLoginRoute &&
      meError instanceof SwrHttpError &&
      meError.status === 401
    ) {
      void clearAllSwrCaches(cache, mutate).finally(() => {
        router.replace('/login?expired=1');
      });
    }
  }, [cache, isLoginRoute, meError, mutate, router]);

  useEffect(() => {
    if (isLoginRoute) return;

    let cancelled = false;
    fetch('/api/system/remote', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error?.message || 'Unable to check remote access.');
        }
        if (!cancelled) setRemoteTunnel(payload.tunnel);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRemoteError(
            error instanceof Error ? error.message : 'Unable to check remote access.'
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isLoginRoute]);

  const fetchedActiveCount = useMemo(() => {
    if (!jobsSummaryData) {
      return 0;
    }
    if (typeof jobsSummaryData.counts?.active === 'number') {
      return jobsSummaryData.counts.active;
    }
    if (Array.isArray(jobsSummaryData.jobs)) {
      return jobsSummaryData.jobs.filter((job) =>
        ACTIVE_STATUSES.has(job.status)
      ).length;
    }
    return 0;
  }, [jobsSummaryData]);

  useEffect(() => {
    if (jobsSummaryData) {
      setLiveActiveCount(fetchedActiveCount);
    }
  }, [fetchedActiveCount, jobsSummaryData]);

  useEffect(() => {
    if (isLoginRoute) {
      return;
    }

    function handleJobsUpdated(event: Event) {
      const customEvent = event as CustomEvent<{ activeCount?: number }>;
      if (typeof customEvent.detail?.activeCount === 'number') {
        setLiveActiveCount(Math.max(0, customEvent.detail.activeCount));
      }
    }

    window.addEventListener('mediavault:jobs-updated', handleJobsUpdated);
    return () => {
      window.removeEventListener('mediavault:jobs-updated', handleJobsUpdated);
    };
  }, [isLoginRoute]);

  if (isLoginRoute) {
    return <>{children}</>;
  }

  async function handleLogout() {
    if (signingOut) {
      return;
    }

    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        cache: 'no-store',
      });
    } finally {
      setLiveActiveCount(null);
      await clearAllSwrCaches(cache, mutate);
      router.replace('/login');
      router.refresh();
      setSigningOut(false);
    }
  }

  async function changeRemoteTunnel(method: 'POST' | 'DELETE') {
    if (remoteBusy) return;
    setRemoteBusy(true);
    setRemoteError(null);
    setRemoteCopied(false);
    try {
      const response = await fetch('/api/system/remote', {
        method,
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error?.message || 'Unable to update remote access.');
      }
      setRemoteTunnel(payload.tunnel);
    } catch (error) {
      setRemoteError(
        error instanceof Error ? error.message : 'Unable to update remote access.'
      );
    } finally {
      setRemoteBusy(false);
    }
  }

  function handleRemoteButtonClick() {
    setRemotePanelOpen(true);
    if (remoteTunnel.url || remoteBusy) return;
    void changeRemoteTunnel('POST');
  }

  async function handleCopyRemoteUrl() {
    if (!remoteTunnel.url) return;
    try {
      await navigator.clipboard.writeText(remoteTunnel.url);
      setRemoteCopied(true);
    } catch {
      setRemoteError('Could not copy the URL. Copy it directly from the field.');
    }
  }

  function renderRemoteControl(compact = false) {
    return (
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={handleRemoteButtonClick}
          aria-expanded={remotePanelOpen}
          aria-haspopup="dialog"
          className={`mv-focus inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border-default bg-surface-elevated px-2.5 text-ink-secondary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong hover:text-ink-primary ${
            compact ? 'text-xs' : 'text-[13px]'
          }`}
        >
          {remoteBusy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Globe className="h-4 w-4" aria-hidden="true" />
          )}
          <span>Remote</span>
        </button>

        {remotePanelOpen && (
          <section
            role="dialog"
            aria-label="Remote access"
            className="absolute top-full right-0 z-[60] mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border-default bg-surface-elevated p-4 text-ink-primary shadow-[var(--shadow-overlay)]"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Remote access</h2>
                <p className="mt-1 text-xs text-ink-muted">
                  {remoteBusy
                    ? 'Starting a temporary secure tunnel…'
                    : remoteTunnel.url
                      ? 'Your temporary link is ready.'
                      : 'Start a temporary link to access MediaVault remotely.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRemotePanelOpen(false)}
                aria-label="Close remote access"
                className="mv-focus rounded-md p-1 text-ink-muted transition-colors hover:bg-surface-high hover:text-ink-primary"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {remoteTunnel.url && (
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border-default bg-surface-recessed p-2">
                <a
                  href={remoteTunnel.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate font-mono text-xs text-accent-text hover:underline"
                >
                  {remoteTunnel.url}
                </a>
                <button
                  type="button"
                  onClick={() => void handleCopyRemoteUrl()}
                  className="mv-focus inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border-default bg-surface-elevated px-2 text-xs font-medium text-ink-secondary transition-colors hover:text-ink-primary"
                >
                  {remoteCopied ? (
                    <Check className="h-3.5 w-3.5 text-ready" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {remoteCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}

            {remoteError && (
              <p role="alert" className="mt-3 text-xs text-failed">
                {remoteError}
              </p>
            )}

            {remoteTunnel.url && (
              <button
                type="button"
                onClick={() => void changeRemoteTunnel('DELETE')}
                disabled={remoteBusy}
                className="mv-focus mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-failed-border bg-failed-bg px-2.5 text-xs font-medium text-failed transition-colors hover:opacity-80 disabled:opacity-50"
              >
                {remoteBusy ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Stop tunnel
              </button>
            )}
          </section>
        )}
      </div>
    );
  }

  const user = meData?.user ?? null;
  const activeJobCount = liveActiveCount ?? fetchedActiveCount;
  const nodeStatus: 'checking' | 'online' | 'offline' = healthError
    ? 'offline'
    : healthData
      ? healthData.status === 'ok'
        ? 'online'
        : 'offline'
      : healthLoading
        ? 'checking'
        : 'offline';

  const userInitial = user?.email ? user.email.charAt(0).toUpperCase() : null;
  const dotClass =
    nodeStatus === 'online'
      ? 'bg-ready-dot'
      : nodeStatus === 'offline'
        ? 'bg-failed-dot'
        : 'bg-muxing-dot';

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink-primary">
      {/* Desktop Sticky Top Bar (>= 768px) */}
      <header className="fixed inset-x-0 top-0 z-50 hidden h-14 border-b border-border-subtle bg-canvas/85 backdrop-blur-md md:block">
        <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-4 px-6">
          {/* Brand Left */}
          <Link href="/" className="mv-focus flex items-center gap-2.5 rounded-lg py-1 pr-2">
            <MediaVaultLogo
              size={32}
              className="shrink-0 rounded-lg shadow-[var(--shadow-xs)]"
            />
            <span className="text-sm font-semibold tracking-tight text-ink-primary">
              MediaVault
            </span>
            <span className="rounded border border-border-default bg-surface px-1.5 py-0.5 font-mono text-[11px] font-medium leading-none text-ink-muted">
              v2.4.0
            </span>
          </Link>

          {/* Center Pill Navigation */}
          <nav
            aria-label="Primary"
            className="flex items-center gap-1 rounded-full border border-border-default bg-surface-recessed p-1"
          >
            {NAV_ITEMS.map((item) => {
              const isActive =
                item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  className={`mv-focus inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] transition-colors ${
                    isActive
                      ? 'border-border-default bg-surface-elevated font-semibold text-ink-primary shadow-[var(--shadow-xs)]'
                      : 'border-transparent font-medium text-ink-secondary hover:bg-surface-elevated/60 hover:text-ink-primary'
                  }`}
                >
                  <span>{item.desktopLabel}</span>
                  {item.href === '/queue' && (
                    <span
                      className="rounded-full border border-accent-border bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none tabular-nums text-accent-text"
                      aria-label={`${activeJobCount} active jobs`}
                    >
                      {activeJobCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Right Status & Session Controls */}
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-2 rounded-full border border-border-default bg-surface-elevated px-3 py-1 shadow-[var(--shadow-xs)]"
              title="MediaVault Daemon Status"
            >
              <span className="relative flex h-2 w-2">
                {nodeStatus === 'online' && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ready-dot opacity-75" />
                )}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${dotClass}`} />
              </span>
              <span className="font-mono text-[11px] text-ink-muted">
                Local Node{' '}
                <span
                  className={`hidden font-medium lg:inline ${
                    nodeStatus === 'online'
                      ? 'text-ready'
                      : nodeStatus === 'offline'
                        ? 'text-failed'
                        : 'text-muxing'
                  }`}
                >
                  (
                  {nodeStatus === 'online'
                    ? 'Online · 127.0.0.1'
                    : nodeStatus === 'offline'
                      ? 'Offline'
                      : 'Checking'}
                  )
                </span>
              </span>
            </div>

            {renderRemoteControl()}
            <ThemeToggle />

            <button
              type="button"
              onClick={handleLogout}
              disabled={signingOut}
              aria-label="Sign out"
              title="Sign out"
              data-testid="desktop-logout-button"
              className="mv-focus inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-border-default bg-surface-elevated text-ink-secondary shadow-[var(--shadow-xs)] transition-colors hover:border-failed-border hover:bg-failed-bg hover:text-failed disabled:opacity-50"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>

            <Link
              href="/settings"
              aria-label={user ? `Account settings for ${user.email}` : 'Account settings'}
              title={user?.email || 'Account settings'}
              className="mv-focus inline-flex h-8 w-8 items-center justify-center rounded-full border border-border-default bg-surface-high font-mono text-xs font-semibold text-ink-primary shadow-[var(--shadow-xs)] transition-colors hover:border-border-strong"
            >
              {userInitial ?? <User className="h-4 w-4" aria-hidden="true" />}
            </Link>
          </div>
        </div>
      </header>

      {/* Mobile Compact Header (< 768px) */}
      <header className="pt-safe fixed inset-x-0 top-0 z-50 border-b border-border-subtle bg-canvas/90 backdrop-blur-xl md:hidden">
        <div className="flex h-12 items-center justify-between gap-2 px-4">
          <Link href="/" className="mv-focus flex items-center gap-1.5 rounded-lg py-0.5 pr-1">
            <MediaVaultLogo size={24} className="shrink-0" />
            <span className="text-sm font-semibold tracking-tight text-ink-primary">
              MediaVault
            </span>
            <span className="rounded bg-surface-highest px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase leading-none text-ink-secondary">
              v2.4.0
            </span>
          </Link>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-2 py-1">
              <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
              <span className="font-mono text-[11px] text-ready">Local Node</span>
            </div>

            {renderRemoteControl(true)}
            <ThemeToggle className="rounded-full" />

            <Link
              href="/settings"
              aria-label={user ? `Account settings for ${user.email}` : 'Account settings'}
              className="mv-focus inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent font-mono text-xs font-semibold text-on-accent"
            >
              {userInitial ?? <User className="h-4 w-4" aria-hidden="true" />}
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content Workspace */}
      <main className="w-full flex-1 pt-12 pb-20 md:pt-14 md:pb-8">{children}</main>

      {/* Desktop Utility Footer */}
      <footer className="hidden w-full border-t border-border-subtle bg-surface-recessed py-4 md:block">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-6 font-mono text-[11px] text-ink-muted">
          <span>MediaVault Daemon · Local Storage Sandbox · Stream-Copy Engine</span>
          <div className="flex items-center gap-4">
            <Link href="/" className="transition-colors hover:text-ink-primary">
              Downloader
            </Link>
            <Link href="/queue" className="transition-colors hover:text-ink-primary">
              Queue
            </Link>
            <Link href="/settings" className="transition-colors hover:text-ink-primary">
              Settings
            </Link>
          </div>
        </div>
      </footer>

      {/* Mobile Fixed Bottom Tab Bar (< 768px) */}
      <nav
        aria-label="Mobile Primary"
        className="pb-safe fixed inset-x-0 bottom-0 z-50 border-t border-border-subtle bg-canvas/95 backdrop-blur-xl md:hidden"
      >
        <div className="grid h-14 grid-cols-3 items-center px-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive =
              item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={`mv-focus relative flex min-h-[44px] min-w-[64px] flex-col items-center justify-center rounded-lg transition-colors ${
                  isActive
                    ? 'font-semibold text-accent-text'
                    : 'font-medium text-ink-secondary hover:text-ink-primary'
                }`}
              >
                <div className="relative">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  {item.href === '/queue' && activeJobCount > 0 && (
                    <span className="absolute -top-1 -right-2.5 rounded-full bg-accent px-1 py-0.5 font-mono text-[10px] font-semibold leading-none tabular-nums text-on-accent">
                      {activeJobCount}
                    </span>
                  )}
                </div>
                <span className="mt-0.5 text-[11px] leading-[14px] tracking-[0.02em]">
                  {item.mobileLabel}
                </span>
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0.5 h-0.5 w-6 rounded-full bg-accent"
                  />
                )}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
