'use client';

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ClipboardPaste,
  HelpCircle,
  Link2,
  Loader2,
  Lock,
  Search,
  X,
} from 'lucide-react';
import {
  SUPPORTED_PLATFORMS,
  SUPPORTED_PROVIDER_COUNT,
  deriveCookiePlatformSlug,
} from '@/lib/mediaTypes';

interface UrlInputCardProps {
  variant: 'hero' | 'compact';
  url: string;
  onUrlChange: (value: string) => void;
  useCookies: boolean;
  onUseCookiesChange: (checked: boolean) => void;
  singleItemOnly?: boolean;
  onSingleItemOnlyChange?: (checked: boolean) => void;
  loading: boolean;
  error: string | null;
  onClearError: () => void;
  statusBadge?: string | null;
  onInspect: () => void;
  onClear: () => void;
}

function isValidHttpUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAuthOrAgeError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /age|cookie|sign\s?in|auth|private|login|registered|members?|bot|403/i.test(message);
}

function CookieHelpLink({ url }: { url: string }) {
  const slug = deriveCookiePlatformSlug(url);
  const href = slug
    ? `/settings?cookieSite=${encodeURIComponent(slug)}#cookie-upload`
    : '/settings#age-restricted-guide';
  return (
    <Link
      href={href}
      data-testid="error-age-restricted-guide-link"
      className="ml-1.5 font-semibold underline underline-offset-2 hover:opacity-90"
    >
      {slug ? `Upload cookies for ${slug} →` : 'See age-restricted video guide →'}
    </Link>
  );
}

export function UrlInputCard({
  variant,
  url,
  onUrlChange,
  useCookies,
  onUseCookiesChange,
  singleItemOnly = false,
  onSingleItemOnlyChange,
  loading,
  error,
  onClearError,
  statusBadge,
  onInspect,
  onClear,
}: UrlInputCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();
  const cookiesId = useId();
  const singleOnlyId = useId();

  const [touched, setTouched] = useState<boolean>(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [clipboardHint, setClipboardHint] = useState<string | null>(null);

  const displayError = error || (touched ? clientError : null);

  function validateCurrentUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return 'Enter a media or playlist URL to inspect.';
    }
    if (!isValidHttpUrl(trimmed)) {
      return 'Enter a full http:// or https:// media or playlist URL.';
    }
    return null;
  }

  function handleChange(nextValue: string) {
    onUrlChange(nextValue);
    setClipboardHint(null);
    if (error) {
      onClearError();
    }
    if (touched) {
      setClientError(nextValue.trim() ? validateCurrentUrl(nextValue) : null);
    } else if (clientError) {
      setClientError(null);
    }
    if (!nextValue.trim()) {
      setTouched(false);
    }
  }

  function handleBlur() {
    if (url.trim().length > 0) {
      setTouched(true);
      setClientError(validateCurrentUrl(url));
    }
  }

  function handleClearClick() {
    setTouched(false);
    setClientError(null);
    setClipboardHint(null);
    onClearError();
    onClear();
    inputRef.current?.focus();
  }

  async function handlePasteClick() {
    setClipboardHint(null);
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        const trimmed = text.trim();
        if (trimmed) {
          onUrlChange(trimmed);
          onClearError();
          setTouched(true);
          setClientError(validateCurrentUrl(trimmed));
          inputRef.current?.focus();
          return;
        }
      }
    } catch {
      // Clipboard API unavailable or blocked in browser context
    }
    setClipboardHint('Clipboard permission unavailable — paste directly into the field.');
    inputRef.current?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) {
      return;
    }
    setTouched(true);
    setClipboardHint(null);
    const validationMsg = validateCurrentUrl(url);
    if (validationMsg) {
      setClientError(validationMsg);
      inputRef.current?.focus();
      return;
    }
    setClientError(null);
    onInspect();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape' && url.length > 0 && !loading) {
      event.preventDefault();
      handleClearClick();
    }
  }

  const switchProps = { switch: '' } as Record<string, string>;

  if (variant === 'compact') {
    return (
      <section
        aria-label="Media URL inspector"
        className="flex flex-col gap-2.5 rounded-xl border border-border-default bg-surface p-3 shadow-[var(--shadow-xs)]"
      >
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="mv-url-wrapper flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border-default bg-surface-recessed px-3 py-1.5 transition-colors focus-within:border-accent">
              <Link2 className="h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />
              <label htmlFor={inputId} className="sr-only">
                Media or playlist URL
              </label>
              <input
                ref={inputRef}
                id={inputId}
                type="url"
                value={url}
                onChange={(e) => handleChange(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste any video or audio URL (YouTube, TikTok, Vimeo, 1,700+ sites)..."
                aria-invalid={displayError ? 'true' : 'false'}
                aria-describedby={displayError ? errorId : undefined}
                data-testid="url-input"
                className="mv-url-input min-w-0 flex-1 bg-transparent py-1 font-mono text-[13px] text-ink-primary placeholder:text-ink-placeholder focus:outline-none"
              />
              {url.length > 0 && !loading && (
                <button
                  type="button"
                  onClick={handleClearClick}
                  aria-label="Clear URL and return to empty state"
                  data-testid="clear-url-btn"
                  className="mv-focus inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-high hover:text-ink-primary"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Clear</span>
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 sm:justify-end">
              {statusBadge && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-ready-border bg-ready-bg px-2.5 py-1 font-mono text-[11px] font-medium tabular-nums text-ready">
                  <span className="h-1.5 w-1.5 rounded-full bg-ready-dot" />
                  <span>{statusBadge}</span>
                </span>
              )}

              <div className="flex flex-1 items-center justify-end gap-2 sm:flex-initial">
                <button
                  type="button"
                  onClick={handlePasteClick}
                  disabled={loading}
                  className="mv-focus inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border-default bg-surface-elevated px-3 text-[13px] font-medium text-ink-secondary transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary disabled:opacity-50 sm:h-9"
                >
                  <ClipboardPaste className="h-4 w-4" aria-hidden="true" />
                  <span>Paste</span>
                </button>

                <button
                  type="submit"
                  disabled={loading}
                  data-testid="inspect-btn"
                  className="mv-focus inline-flex h-10 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-accent px-4 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-wait disabled:opacity-70 sm:h-9 sm:flex-initial"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      <span>Probing...</span>
                    </>
                  ) : (
                    <>
                      <Search className="h-4 w-4" aria-hidden="true" />
                      <span>Inspect</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 pt-0.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <label
                htmlFor={cookiesId}
                className="flex cursor-pointer select-none items-center gap-2 text-xs text-ink-secondary hover:text-ink-primary"
              >
                <input
                  id={cookiesId}
                  type="checkbox"
                  role="switch"
                  checked={useCookies}
                  onChange={(e) => onUseCookiesChange(e.target.checked)}
                  {...switchProps}
                  data-testid="cookies-switch"
                  className="mv-switch"
                />
                <Lock className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                <span>Use saved cookies</span>
              </label>

              <Link
                href="/settings#age-restricted-guide"
                data-testid="age-restricted-guide-link"
                className="mv-focus inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-accent-text transition-colors hover:underline underline-offset-4"
              >
                <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>How to access age-restricted videos</span>
              </Link>
            </div>

            {clipboardHint && (
              <span className="font-mono text-[11px] text-ink-muted">{clipboardHint}</span>
            )}
          </div>

          {displayError && (
            <div
              id={errorId}
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-failed-border bg-failed-bg px-3 py-2 text-xs text-failed"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                <strong className="font-semibold">Error:</strong> {displayError}
                {isAuthOrAgeError(displayError) && <CookieHelpLink url={url} />}
              </span>
            </div>
          )}
        </form>
      </section>
    );
  }

  return (
    <section
      aria-label="Media URL inspector"
      className="w-full rounded-xl border border-border-default bg-surface p-2.5 shadow-[var(--shadow-xs)] sm:p-3"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
        {/* Hero Input Well */}
        <div className="mv-url-wrapper flex flex-col gap-2 rounded-lg border border-border-default bg-surface-recessed p-1.5 transition-colors focus-within:border-accent sm:flex-row sm:items-center">
          <div className="relative flex min-w-0 flex-1 items-center px-2">
            <Link2 className="mr-2.5 h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />
            <label htmlFor={inputId} className="sr-only">
              Media or playlist URL
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="url"
              value={url}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              placeholder="Paste any video, audio, or playlist URL (YouTube, TikTok, Vimeo, 1,700+ sites)..."
              aria-invalid={displayError ? 'true' : 'false'}
              aria-describedby={displayError ? errorId : undefined}
              data-testid="url-input"
              className="mv-url-input min-w-0 flex-1 bg-transparent py-2.5 pr-8 font-mono text-[13px] text-ink-primary placeholder:text-ink-placeholder focus:outline-none sm:py-2"
            />
            {url.length > 0 && !loading ? (
              <button
                type="button"
                onClick={handleClearClick}
                aria-label="Clear URL input"
                data-testid="clear-url-btn"
                className="mv-focus absolute right-1 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-high hover:text-ink-primary"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : (
              <kbd className="pointer-events-none hidden select-none rounded border border-border-subtle bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink-muted sm:inline-block">
                Ctrl+V
              </kbd>
            )}
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0 sm:items-center sm:gap-1.5">
            <button
              type="button"
              onClick={handlePasteClick}
              disabled={loading}
              data-testid="paste-btn"
              className="mv-focus inline-flex h-11 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border-default bg-surface-elevated px-3 text-[13px] font-medium text-ink-secondary transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary disabled:opacity-50 sm:h-9"
            >
              <ClipboardPaste className="h-4 w-4 text-accent-text" aria-hidden="true" />
              <span>Paste</span>
            </button>

            <button
              type="submit"
              disabled={loading}
              data-testid="inspect-btn"
              className="mv-focus inline-flex h-11 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-accent px-4 text-[13px] font-semibold text-on-accent shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-wait disabled:opacity-70 sm:h-9"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>Probing...</span>
                </>
              ) : (
                <>
                  <Search className="h-4 w-4" aria-hidden="true" />
                  <span>Inspect</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Validation / API Error Alert */}
        {displayError && (
          <div
            id={errorId}
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-failed-border bg-failed-bg px-3 py-2 text-xs text-failed"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              <strong className="font-semibold">Error:</strong> {displayError}
              {isAuthOrAgeError(displayError) && <CookieHelpLink url={url} />}
            </span>
          </div>
        )}

        {clipboardHint && !displayError && (
          <p className="px-1 font-mono text-[11px] text-ink-muted">{clipboardHint}</p>
        )}

        {/* Controls & Supported Resolvers Sub-Row */}
        <div className="flex flex-col gap-2.5 border-t border-border-subtle px-1 pt-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label
              htmlFor={cookiesId}
              className="flex cursor-pointer select-none items-center gap-2 text-xs text-ink-secondary hover:text-ink-primary"
            >
              <input
                id={cookiesId}
                type="checkbox"
                role="switch"
                checked={useCookies}
                onChange={(e) => onUseCookiesChange(e.target.checked)}
                {...switchProps}
                data-testid="cookies-switch"
                className="mv-switch"
              />
              <Lock className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
              <span>Use saved cookies</span>
            </label>

            {onSingleItemOnlyChange && (
              <label
                htmlFor={singleOnlyId}
                className="flex cursor-pointer select-none items-center gap-2 text-xs text-ink-secondary hover:text-ink-primary"
              >
                <input
                  id={singleOnlyId}
                  type="checkbox"
                  role="switch"
                  checked={singleItemOnly}
                  onChange={(e) => onSingleItemOnlyChange(e.target.checked)}
                  {...switchProps}
                  data-testid="single-item-switch"
                  className="mv-switch"
                />
                <span>Single item only</span>
              </label>
            )}

            <Link
              href="/settings#age-restricted-guide"
              data-testid="age-restricted-guide-link"
              className="mv-focus inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-accent-text transition-colors hover:underline underline-offset-4"
            >
              <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>How to access age-restricted videos</span>
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 hidden text-[11px] font-medium uppercase tracking-[0.02em] text-ink-muted sm:inline">
              Supported:
            </span>
            {SUPPORTED_PLATFORMS.map((platform) => (
              <span
                key={platform.id}
                className="rounded border border-border-default bg-surface-elevated px-2 py-0.5 font-mono text-[11px] font-medium text-ink-secondary"
              >
                <span className="sm:hidden">{platform.shortLabel}</span>
                <span className="hidden sm:inline">{platform.label}</span>
              </span>
            ))}
            <span className="rounded border border-accent-border bg-accent-soft px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-accent-text">
              {SUPPORTED_PROVIDER_COUNT.toLocaleString('en-US')}+ sites
            </span>
          </div>
        </div>
      </form>
    </section>
  );
}
