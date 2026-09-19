import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseThemeCookie,
  resolveTheme,
  themeClassName,
  ThemeProvider,
  ThemeToggle,
  useTheme,
} from '../index.ts';

/** Reads the context without rendering any chrome. */
function Probe() {
  const { theme, resolved } = useTheme();
  return <span data-testid="state">{`${theme}:${resolved}`}</span>;
}

/** A `matchMedia` stub with the OS preference the test needs. */
function stubMatchMedia(prefersDark: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('dark') && prefersDark,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** A `useTheme()` call outside a provider is a programming error, not a default. */
function Orphan() {
  useTheme();
  return null;
}

afterEach(() => {
  const root = document.documentElement;
  root.classList.remove('dark');
  delete root.dataset['theme'];
  document.cookie = 'slate-theme=; max-age=0';
  stubMatchMedia(false);
});

describe('theme resolution (server-safe)', () => {
  it('treats an unknown or absent cookie value as the system preference', () => {
    expect(parseThemeCookie(undefined)).toBe('system');
    expect(parseThemeCookie('sepia')).toBe('system');
    expect(parseThemeCookie('dark')).toBe('dark');
  });

  it('resolves the system preference from the OS, not from the client', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    // An explicit choice always wins over the OS.
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('maps a resolved theme onto the root class', () => {
    expect(themeClassName('dark')).toBe('dark');
    expect(themeClassName('light')).toBe('');
  });
});

describe('ThemeProvider', () => {
  it('throws when the hook is used outside a provider', () => {
    expect(() => render(<Orphan />)).toThrow(/inside <ThemeProvider>/);
  });

  it('applies the stored preference to the root element', async () => {
    render(
      <ThemeProvider initialTheme="dark">
        <Probe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
    expect(screen.getByTestId('state').textContent).toBe('dark:dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('follows the operating system when the preference is system', async () => {
    stubMatchMedia(true);
    render(
      <ThemeProvider initialTheme="system">
        <Probe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('system:dark');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('switches the theme and stores the choice where the server can read it', async () => {
    render(
      <ThemeProvider initialTheme="dark">
        <ThemeToggle />
      </ThemeProvider>,
    );

    const toggle = await screen.findByRole('button', { name: 'Switch to light theme' });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
    expect(document.cookie).toContain('slate-theme=light');
    // The accessible name states the outcome, so it flips with the theme.
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy();
  });
});
