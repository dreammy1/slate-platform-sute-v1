'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { Button } from '../components/button.tsx';
import {
  resolveTheme,
  themeClassName,
  themeCookie,
  type ResolvedTheme,
  type Theme,
} from './theme.ts';

export interface ThemeContextValue {
  /** The stored preference, including `system`. */
  readonly theme: Theme;
  /** What is actually rendered. */
  readonly resolved: ResolvedTheme;
  /** Stores the preference in a cookie so the server can render it next time. */
  readonly setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  readonly children: ReactNode;
  /** Resolved on the server from the preference cookie (ADR 008 §3). */
  readonly initialTheme?: Theme;
}

/** The OS preference, guarded so the server render can call this safely. */
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Applies the theme to the root element and exposes it to descendants.
 *
 * The server has already put the stored preference on the root element, so the
 * only work left is the part no server can do: choosing `light` or `dark` for
 * `system`, and storing a new choice. `prefers-color-scheme` is read in an effect
 * rather than during render, which keeps the first client render identical to the
 * server's markup and avoids a hydration mismatch.
 */
export function ThemeProvider({ children, initialTheme = 'system' }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [systemDark, setSystemDark] = useState(false);
  const resolved = resolveTheme(theme, systemDark);

  useEffect(() => {
    setSystemDark(systemPrefersDark());
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', themeClassName(resolved) === 'dark');
    root.dataset['theme'] = resolved;
  }, [resolved]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    // Not `httpOnly`: a theme preference carries no authority, and the server must
    // be able to read it to render the right theme on the next request.
    document.cookie = themeCookie(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Reads the theme context. Throws when used outside a provider. */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error('useTheme must be used inside <ThemeProvider> (ADR 008 §3).');
  }
  return context;
}

export interface ThemeToggleProps {
  readonly className?: string;
}

/**
 * Switches between light and dark. Its accessible name states the outcome, so
 * "what does this button do?" is answered without seeing the icon.
 */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const { resolved, setTheme } = useTheme();
  const next: Theme = resolved === 'dark' ? 'light' : 'dark';

  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {next === 'dark' ? 'Dark' : 'Light'}
    </Button>
  );
}
