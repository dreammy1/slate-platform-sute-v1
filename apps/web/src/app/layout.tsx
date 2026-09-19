import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { ThemeProvider, THEME_COOKIE_NAME, parseThemeCookie } from '@slate/ui';

import './globals.css';

export const metadata: Metadata = {
  title: 'Slate',
  description: 'The Slate platform workspace.',
};

/**
 * The root layout (ADR 008 §3). The theme is resolved on the server from the
 * preference cookie and put on `<html>` as a class, so the first paint already
 * carries the right theme — no flash, because the client provider only *keeps*
 * the server's decision up to date rather than choosing it after hydration.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const theme = parseThemeCookie(store.get(THEME_COOKIE_NAME)?.value);

  return (
    // `system` is resolved on the client by the provider (the server cannot see
    // `prefers-color-scheme`); explicit light/dark choices render flash-free.
    <html lang="en" className={theme === 'dark' ? 'dark' : ''}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemeProvider initialTheme={theme}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
