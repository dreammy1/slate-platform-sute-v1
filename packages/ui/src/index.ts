/**
 * `@slate/ui` — the Slate design system (SLATE-300, ADR 008).
 *
 * The export inventory is split by boundary, and the split is documented here
 * because an app has to know which side an import is on (ADR 008 §4):
 *
 * **Server-safe** (no directive, no browser API, renderable from a Server
 * Component): `Button`, the `Card` family, `cn`, and the theme helpers
 * (`Theme`, `resolveTheme`, `parseThemeCookie`, `themeClassName`, `themeCookie`,
 * `isTheme`, `THEME_COOKIE_NAME`).
 *
 * **Client-only** (`'use client'`; render them as leaves and pass data, never
 * authority): `Input`, `Modal`, `ThemeProvider`, `useTheme`, `ThemeToggle`.
 *
 * Style contract: import the tokens once per app via
 * `@slate/ui/styles/tokens.css` and map them with
 * `@slate/config/tailwind/theme.css` (ADR 008 §3).
 */

export { Button, type ButtonProps } from './components/button.tsx';
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardTitleProps,
} from './components/card.tsx';
export { Input, type InputProps } from './components/input.tsx';
export { Modal, type ModalProps } from './components/modal.tsx';

export { cn } from './lib/cn.ts';

export {
  isTheme,
  parseThemeCookie,
  resolveTheme,
  themeClassName,
  themeCookie,
  THEME_COOKIE_MAX_AGE,
  THEME_COOKIE_NAME,
  type ResolvedTheme,
  type Theme,
} from './providers/theme.ts';
export {
  ThemeProvider,
  ThemeToggle,
  useTheme,
  type ThemeContextValue,
  type ThemeProviderProps,
  type ThemeToggleProps,
} from './providers/theme-provider.tsx';
