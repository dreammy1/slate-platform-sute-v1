/**
 * Theme resolution (SLATE-300, ADR 008 §3).
 *
 * This module is **server-safe**: it has no directive, no React import and no
 * browser dependency, so a Server Component can resolve the theme while it
 * renders. The matching client provider lives in `theme-provider.tsx`.
 *
 * The stored preference is a plain cookie, deliberately not `httpOnly`: a theme
 * preference carries no authority and nothing about it is secret, unlike the
 * session cookie, which the browser must never be able to read.
 */

/** What a user can choose. `system` follows the operating system. */
export type Theme = 'light' | 'dark' | 'system';

/** What is actually rendered; `system` is resolved before it reaches here. */
export type ResolvedTheme = 'light' | 'dark';

/** Cookie holding the explicit preference. */
export const THEME_COOKIE_NAME = 'slate-theme';

/** One year, in seconds — a preference, not a session. */
export const THEME_COOKIE_MAX_AGE = 31_536_000;

const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

/** Narrowing check for an untrusted cookie value. */
export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** Reads the cookie value from a Next.js cookie store without trusting its type. */
export function parseThemeCookie(value: string | undefined | null): Theme {
  return isTheme(value) ? value : 'system';
}

/**
 * Collapses a preference into what is rendered.
 *
 * `prefersDark` is only consulted for `system`, and is passed in rather than read
 * here so the function stays pure and testable.
 */
export function resolveTheme(theme: Theme, prefersDark = false): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

/** The class the root element carries. Light is the absence of the override. */
export function themeClassName(resolved: ResolvedTheme): string {
  return resolved === 'dark' ? 'dark' : '';
}

/** The `Set-Cookie` fragment a client writes when the user picks a theme. */
export function themeCookie(theme: Theme): string {
  return `${THEME_COOKIE_NAME}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
}
