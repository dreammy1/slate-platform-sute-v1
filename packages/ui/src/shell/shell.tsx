/**
 * The authenticated shell chrome (SLATE-301, ADR 009 §2).
 *
 * Pure presentation: every prop is server-resolved data (never authority), and
 * the component makes no fetch, reads no cookie, and touches no storage. The
 * layout renders it with the filtered navigation; client interactivity stays in
 * the leaves (`TenantSwitcherForm`, `ThemeToggle`, sign-out form).
 */

import type { ReactNode } from 'react';

import { cn } from '../lib/cn.ts';
import type { ShellNavigationEntry } from './navigation.ts';

/** One tenant option: server-resolved membership, rendered as text. */
export interface ShellTenantOption {
  readonly id: string;
  readonly name: string;
}

/** Server-resolved identity for the profile tray (no permission keys). */
export interface ShellUser {
  readonly name: string;
  readonly email: string;
}

/** What the layout passes to the shell: data only, never authority. */
export interface ShellProps {
  readonly appName: string;
  readonly navigation: readonly ShellNavigationEntry[];
  readonly activePath: string;
  readonly user: ShellUser;
  readonly tenantName: string;
  readonly tenants: readonly ShellTenantOption[];
  readonly activeTenantId: string;
  readonly requestId: string | undefined;
  readonly tenantSwitcher: ReactNode;
  readonly signOut: ReactNode;
  readonly themeToggle: ReactNode;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

/**
 * Sidebar plus topbar plus content region. Semantic landmarks (`banner`,
 * `navigation`, `main`, `contentinfo`) so assistive technology and the axe
 * `region` rule see a complete page; `aria-current` marks the active entry.
 */
export function Shell({
  appName,
  navigation,
  activePath,
  user,
  tenantName,
  tenants,
  activeTenantId,
  requestId,
  tenantSwitcher,
  signOut,
  themeToggle,
  children,
  className,
}: ShellProps) {
  const activeTenant = tenants.find((tenant) => tenant.id === activeTenantId) ?? {
    id: activeTenantId,
    name: tenantName,
  };

  return (
    <div className={cn('flex min-h-screen bg-background text-foreground', className)}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside
        aria-label={`${appName} navigation`}
        className="hidden w-60 shrink-0 flex-col gap-2 border-r border-border bg-surface p-4 md:flex"
      >
        <p className="px-2 text-sm font-semibold">{appName}</p>
        <nav aria-label="Primary navigation">
          <ul className="flex flex-col gap-1">
            {navigation.map((entry) => {
              const active = entry.href === activePath;
              return (
                <li key={entry.id}>
                  <a
                    href={entry.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-2 py-1.5 text-sm',
                      active
                        ? 'bg-muted font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {entry.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="mt-auto flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <span>Acting in {activeTenant.name}</span>
          {requestId === undefined ? null : <span>Request {requestId}</span>}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2">
          <p className="text-sm font-semibold md:hidden">{appName}</p>
          <nav aria-label="Mobile navigation" className="md:hidden">
            <ul className="flex flex-wrap gap-1">
              {navigation.map((entry) => (
                <li key={entry.id}>
                  <a
                    href={entry.href}
                    aria-current={entry.href === activePath ? 'page' : undefined}
                    className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {entry.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {tenantSwitcher}
            {themeToggle}
            <details className="relative">
              <summary
                aria-label={`Profile for ${user.email}`}
                className="cursor-pointer list-none rounded-md border border-border px-2 py-1 text-sm"
              >
                {user.name}
              </summary>
              <div className="absolute right-0 z-50 mt-1 w-64 rounded-md border border-border bg-background p-3 shadow-md">
                <p className="text-sm font-medium">{user.name}</p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
                <p className="mt-1 text-xs text-muted-foreground">Tenant: {activeTenant.name}</p>
                <div className="mt-2">{signOut}</div>
              </div>
            </details>
          </div>
        </header>
        <main id="main-content" className="min-w-0 flex-1 p-4 md:p-6">
          {children}
        </main>
        <footer className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Signed in as {user.email} in {activeTenant.name}
          {requestId === undefined ? '' : ` · Request ${requestId}`}
        </footer>
      </div>
    </div>
  );
}
