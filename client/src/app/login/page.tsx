'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';

type AuthMode = 'login' | 'register';

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}

function getSafeNextPath(rawNext: string | null): string {
  if (!rawNext) {
    return '/';
  }
  if (!rawNext.startsWith('/') || rawNext.startsWith('//') || rawNext === '/login') {
    return '/';
  }
  return rawNext;
}

function LoginFormContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const safeNext = getSafeNextPath(searchParams.get('next'));
  const sessionExpired = searchParams.get('expired') === '1';

  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [rememberSession, setRememberSession] = useState<boolean>(true);
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nodeOnline, setNodeOnline] = useState<'checking' | 'online' | 'offline'>('checking');

  useEffect(() => {
    const controller = new AbortController();

    async function checkNodeAndSession() {
      try {
        const healthPromise = fetch('/api/health', {
          cache: 'no-store',
          signal: controller.signal,
        });

        const mePromise = sessionExpired
          ? Promise.resolve(null)
          : fetch('/api/auth/me', {
              cache: 'no-store',
              signal: controller.signal,
            });

        const [healthRes, meRes] = await Promise.all([healthPromise, mePromise]);

        if (controller.signal.aborted) {
          return;
        }

        if (healthRes.ok) {
          const data = (await healthRes.json()) as { status?: string };
          setNodeOnline(data.status === 'ok' ? 'online' : 'offline');
        } else {
          setNodeOnline('offline');
        }

        if (meRes?.ok) {
          router.replace(safeNext);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        setNodeOnline('offline');
      }
    }

    void checkNodeAndSession();

    return () => {
      controller.abort();
    };
  }, [router, safeNext, sessionExpired]);

  function switchMode(nextMode: AuthMode) {
    if (submitting) {
      return;
    }
    setMode(nextMode);
    setErrorMessage(null);
  }

  async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
    try {
      const payload = (await res.json()) as ApiErrorPayload;
      return payload.error?.message || payload.message || fallback;
    } catch {
      return fallback;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) {
      setErrorMessage('Email address and password are required.');
      return;
    }

    if (mode === 'register' && password.length < 8) {
      setErrorMessage('Password must be at least 8 characters long.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      if (mode === 'register') {
        const registerRes = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: normalizedEmail, password }),
        });

        if (!registerRes.ok) {
          const msg = await extractErrorMessage(registerRes, 'Unable to register account.');
          setErrorMessage(msg);
          setSubmitting(false);
          return;
        }
      }

      const loginRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail, password }),
      });

      if (!loginRes.ok) {
        const msg = await extractErrorMessage(loginRes, 'Invalid email or password.');
        setErrorMessage(msg);
        setSubmitting(false);
        return;
      }

      router.replace(safeNext);
      router.refresh();
    } catch {
      setErrorMessage('Network error communicating with MediaVault API.');
      setSubmitting(false);
    }
  }

  const nodeDotClass =
    nodeOnline === 'online'
      ? 'bg-ready-dot'
      : nodeOnline === 'offline'
        ? 'bg-failed-dot'
        : 'bg-muxing-dot';

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-between overflow-x-hidden bg-canvas text-ink-primary">
      {/* Subtle architectural dot grid backdrop */}
      <div
        aria-hidden="true"
        className="auth-dot-grid pointer-events-none fixed inset-0 z-0 opacity-35"
      />

      {/* Minimal Top Security Bar */}
      <header className="z-10 flex w-full items-center justify-between px-4 pt-5 sm:px-6 sm:pt-6">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-accent-text" aria-hidden="true" />
          <span className="text-sm font-semibold uppercase tracking-tight text-ink-primary">
            MediaVault
          </span>
          <span className="rounded border border-ready-border bg-ready-bg px-1.5 py-0.5 font-mono text-[11px] font-medium leading-none text-ready">
            PRIVATE
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-secondary">
            <span className={`inline-block h-1.5 w-1.5 rounded-full animate-pulse ${nodeDotClass}`} />
            <span className="hidden sm:inline">
              {nodeOnline === 'online'
                ? 'NODE 01 ONLINE'
                : nodeOnline === 'offline'
                  ? 'NODE 01 OFFLINE'
                  : 'NODE 01 CHECKING'}
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* Center Security Card */}
      <main className="z-10 flex w-full flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <div className="relative flex w-full flex-col items-center justify-center">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -z-10 h-[380px] w-[380px] rounded-full bg-accent-soft blur-3xl"
          />

          <section
            aria-labelledby="auth-card-title"
            className="relative flex w-full max-w-[380px] flex-col overflow-hidden rounded-xl border border-border-default bg-surface p-6 shadow-[var(--shadow-overlay)] sm:p-8"
          >
            {/* Top 2px accent hairline */}
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-accent to-transparent opacity-80"
            />

            {/* Card Header */}
            <div className="mb-5 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle bg-surface-highest text-accent-text">
                    <Terminal className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <span className="text-sm font-semibold tracking-tight text-ink-primary">
                    MEDIAVAULT
                  </span>
                </div>
                <span className="rounded border border-border-subtle bg-surface-highest px-1.5 py-0.5 font-mono text-[11px] uppercase leading-none text-ink-muted">
                  v2.4.0
                </span>
              </div>

              <div>
                <h1
                  id="auth-card-title"
                  className="text-lg font-semibold tracking-[-0.01em] text-ink-primary"
                >
                  {mode === 'login' ? 'Authenticate Instance' : 'Create Operator Account'}
                </h1>
                <p className="mt-1 text-[13px] leading-snug text-ink-secondary">
                  {mode === 'login'
                    ? 'Enter administrator credentials to access stream ingestion and daemon controls.'
                    : 'Register an authorized account when self-hosted registration is enabled.'}
                </p>
              </div>

              {/* Segmented Sign In / Register Switcher */}
              <div
                role="tablist"
                aria-label="Authentication mode"
                className="grid grid-cols-2 gap-1 rounded-lg border border-border-default bg-surface-recessed p-1"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'login'}
                  onClick={() => switchMode('login')}
                  className={`mv-focus cursor-pointer rounded-md border py-1.5 text-xs transition-colors ${
                    mode === 'login'
                      ? 'border-border-default bg-surface-elevated font-semibold text-ink-primary shadow-[var(--shadow-xs)]'
                      : 'border-transparent font-medium text-ink-muted hover:text-ink-primary'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'register'}
                  onClick={() => switchMode('register')}
                  className={`mv-focus cursor-pointer rounded-md border py-1.5 text-xs transition-colors ${
                    mode === 'register'
                      ? 'border-border-default bg-surface-elevated font-semibold text-ink-primary shadow-[var(--shadow-xs)]'
                      : 'border-transparent font-medium text-ink-muted hover:text-ink-primary'
                  }`}
                >
                  Register
                </button>
              </div>
            </div>

            {/* Alerts */}
            {sessionExpired && !errorMessage && (
              <div
                role="status"
                className="mb-4 flex items-start gap-2 rounded-lg border border-muxing-border bg-muxing-bg px-3 py-2 text-xs text-muxing"
              >
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Your session expired. Sign in again to continue.</span>
              </div>
            )}

            {errorMessage && (
              <div
                role="alert"
                className="mb-4 flex items-start gap-2 rounded-lg border border-failed-border bg-failed-bg px-3 py-2 text-xs text-failed"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Auth Form */}
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="auth-email"
                  className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.02em] text-ink-secondary"
                >
                  <span>Operator Identity</span>
                  <span className="font-mono text-[10px] text-ink-muted">AUTH-ID</span>
                </label>
                <div className="relative flex items-center">
                  <Mail
                    className="pointer-events-none absolute left-3 h-4 w-4 text-ink-muted"
                    aria-hidden="true"
                  />
                  <input
                    id="auth-email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    spellCheck={false}
                    autoCapitalize="none"
                    enterKeyHint="next"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@local.internal"
                    className="mv-focus h-10 w-full rounded-lg border border-border-default bg-surface-recessed pl-9 pr-3 font-mono text-[13px] text-ink-primary placeholder:text-ink-placeholder transition-colors md:h-9"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="auth-password"
                    className="text-[11px] font-medium uppercase tracking-[0.02em] text-ink-secondary"
                  >
                    Master Password
                  </label>
                  <span className="font-mono text-[11px] text-ink-muted">
                    {mode === 'register' ? 'Min 8 chars' : 'HTTP-only JWT'}
                  </span>
                </div>
                <div className="relative flex items-center">
                  <KeyRound
                    className="pointer-events-none absolute left-3 h-4 w-4 text-ink-muted"
                    aria-hidden="true"
                  />
                  <input
                    id="auth-password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    minLength={mode === 'register' ? 8 : undefined}
                    enterKeyHint="done"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'register' ? 'Minimum 8 characters' : 'Enter password'}
                    className="mv-focus h-10 w-full rounded-lg border border-border-default bg-surface-recessed pl-9 pr-9 font-mono text-[13px] text-ink-primary placeholder:text-ink-placeholder transition-colors md:h-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="mv-focus absolute right-1.5 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-high hover:text-ink-primary"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              {mode === 'login' && (
                <label className="flex cursor-pointer select-none items-center gap-2 pt-0.5">
                  <input
                    id="remember-session"
                    type="checkbox"
                    checked={rememberSession}
                    onChange={(e) => setRememberSession(e.target.checked)}
                    className="h-4 w-4 cursor-pointer rounded border-border-default bg-surface-recessed"
                  />
                  <span className="font-mono text-[11px] text-ink-secondary">
                    Remember session for 7 days
                  </span>
                </label>
              )}

              <button
                type="submit"
                disabled={submitting}
                data-testid="auth-submit-btn"
                className="mv-focus group mt-1 flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent px-4 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-wait disabled:opacity-70 md:h-9"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    <span>
                      {mode === 'register' ? 'Provisioning Account...' : 'Authenticating...'}
                    </span>
                  </>
                ) : (
                  <>
                    <span>
                      {mode === 'register' ? 'Create Account & Sign In' : 'Sign In to MediaVault'}
                    </span>
                    <ArrowRight
                      className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </>
                )}
              </button>
            </form>

            {/* Card Footer Status Strip */}
            <div className="-mx-6 -mb-6 mt-6 flex flex-col gap-1 border-t border-border-subtle bg-surface-recessed/70 px-6 py-4 font-mono text-[11px] sm:-mx-8 sm:-mb-8 sm:px-8">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-ink-secondary">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${nodeDotClass}`} />
                  <span>Node: 127.0.0.1</span>
                </span>
                <span className="flex items-center gap-1 text-ready">
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  <span>COOKIE AUTH</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-ink-muted">
                <span>Zero-Trust Gateway</span>
                <span className="text-ink-secondary">SYS_DAEMON: ACTIVE</span>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Page Bottom Footer */}
      <footer className="z-10 flex w-full flex-col items-center justify-between gap-2 px-4 pb-5 font-mono text-[11px] text-ink-muted sm:flex-row sm:px-6 sm:pb-6">
        <div className="flex items-center gap-2">
          <span>MEDIAVAULT SECURITY KERNEL</span>
          <span className="text-border-default">/</span>
          <span>SELF-HOSTED GATEWAY</span>
        </div>
        <span>STRICT AUTHORIZATION ZONE</span>
      </footer>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-canvas font-mono text-xs text-ink-muted">
          Initializing MediaVault security gateway...
        </div>
      }
    >
      <LoginFormContent />
    </Suspense>
  );
}
