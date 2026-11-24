'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className = '' }: ThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-default bg-surface-elevated ${className}`}
      />
    );
  }

  const isDark = resolvedTheme === 'dark';
  const nextTheme = isDark ? 'light' : 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      onClick={() => setTheme(nextTheme)}
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      className={`mv-focus inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-border-default bg-surface-elevated text-ink-secondary transition-colors hover:border-border-strong hover:bg-surface-high hover:text-ink-primary ${className}`}
    >
      {isDark ? (
        <Sun className="pointer-events-none h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="pointer-events-none h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
