/**
 * Navigation entries the shell renders (SLATE-301, ADR 009 §2).
 *
 * Each entry declares the permission key the server layout checks with
 * `hasPermission` per request. The list is data: the layout filters it, and a
 * direct fetch to the route re-checks the same key, so hiding is UX only.
 */

/** One shell navigation entry: where it goes, what it needs, how it reads. */
export interface ShellNavigationEntry {
  /** Stable key for React and tests. */
  readonly id: string;
  /** Path inside the app (always app-relative, never a full URL). */
  readonly href: string;
  /** Human label, rendered as text (never HTML). */
  readonly label: string;
  /** Permission key the server checks per request; `undefined` means public. */
  readonly permission?: string | undefined;
}

/** Admin navigation: platform administration (SLATE-301 shell; modules in SLATE-302). */
export const ADMIN_NAVIGATION: readonly ShellNavigationEntry[] = [
  { id: 'overview', href: '/', label: 'Overview' },
  { id: 'tenants', href: '/tenants', label: 'Tenants', permission: 'tenants.read' },
  { id: 'users', href: '/users', label: 'Users', permission: 'users.read' },
  { id: 'features', href: '/features', label: 'Feature flags', permission: 'settings.read' },
  { id: 'health', href: '/health', label: 'System health', permission: 'health.read' },
];

/** Customer navigation: the tenant workspace (SLATE-301; content in SLATE-302). */
export const WEB_NAVIGATION: readonly ShellNavigationEntry[] = [
  { id: 'overview', href: '/', label: 'Overview' },
  { id: 'settings', href: '/settings', label: 'Settings', permission: 'settings.read' },
  { id: 'media', href: '/media', label: 'Media', permission: 'media.read' },
];

/**
 * Filters entries to what the permission set allows.
 *
 * `permissions` is the fresh, server-resolved set (never a client claim); an
 * entry without a key is public and always survives. Pure, so layouts and
 * tests share the exact rule.
 */
export function filterNavigation(
  entries: readonly ShellNavigationEntry[],
  permissions: readonly string[],
): readonly ShellNavigationEntry[] {
  return entries.filter(
    (entry) => entry.permission === undefined || permissions.includes(entry.permission),
  );
}
