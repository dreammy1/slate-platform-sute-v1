import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';

import {
  ADMIN_NAVIGATION,
  Button,
  ThemeProvider,
  ThemeToggle,
  TenantSwitcher,
  THEME_COOKIE_NAME,
  filterNavigation,
  parseThemeCookie,
} from '@slate/ui';

import { requireSession, type AdminSession } from '@/server/session';

import { ShellFrame } from './shell-frame';

import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Slate Admin',
  description: 'Internal administration for the Slate platform.',
};

/** Human text for why a session could not be hydrated (never a code-path leak). */
function signedOutReason(reason: 'no-session' | 'unknown-user' | 'no-membership'): string {
  if (reason === 'unknown-user') return 'the session names a user that no longer exists';
  if (reason === 'no-membership') return 'the account is not a member of any tenant';
  return 'no valid session cookie was presented';
}

/** The data the shell renders, normalized out of the hydration union. */
interface ShellData {
  readonly user: { readonly name: string; readonly email: string };
  readonly tenants: readonly { readonly id: string; readonly name: string }[];
  readonly activeTenantId: string;
  readonly permissions: readonly string[];
  readonly requestId: string | undefined;
}

/**
 * Normalizes a hydration result into shell data. `undefined` means signed out —
 * the one state that must not reach the shell. A tenardless session renders the
 * shell with no active tenant so the switcher can bind one.
 */
function toShellData(session: AdminSession): ShellData | undefined {
  if ('kind' in session && session.kind === 'unauthenticated') return undefined;
  const tenardless = 'kind' in session;
  return {
    user: { name: session.user.name, email: session.user.email },
    tenants: session.tenants.map((tenant) => ({ id: tenant.tenantId, name: tenant.tenantName })),
    activeTenantId: tenardless ? '' : session.activeTenantId,
    permissions: tenardless ? [] : session.permissions,
    requestId: session.requestId,
  };
}

/**
 * The admin root layout (ADR 008 §3 + SLATE-301/302). The theme is resolved on
 * the server from the preference cookie so the first paint is flash-free; the
 * session is hydrated server-side and the shell receives data only. A request
 * without a usable session renders the signed-out surface instead of the shell.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const theme = parseThemeCookie(store.get(THEME_COOKIE_NAME)?.value);
  const session = await requireSession();
  const data = toShellData(session);
  const activeTenant =
    data === undefined
      ? undefined
      : data.tenants.find((tenant) => tenant.id === data.activeTenantId);
  const signedOut =
    'kind' in session && session.kind === 'unauthenticated'
      ? signedOutReason(session.reason)
      : undefined;

  return (
    <html lang="en" className={theme === 'dark' ? 'dark' : ''}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemeProvider initialTheme={theme}>
          {data === undefined ? (
            <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-8">
              <h1 className="text-xl font-semibold text-foreground">Slate Admin</h1>
              <p className="text-sm text-muted-foreground">
                {`Sign in to administer the platform — ${signedOut ?? 'no valid session cookie was presented'}.`}
              </p>
            </main>
          ) : (
            <ShellFrame
              appName="Slate Admin"
              navigation={filterNavigation(ADMIN_NAVIGATION, data.permissions)}
              user={data.user}
              tenantName={activeTenant?.name ?? 'No tenant selected'}
              tenants={data.tenants}
              activeTenantId={data.activeTenantId}
              requestId={data.requestId}
              tenantSwitcher={
                <TenantSwitcher
                  tenants={data.tenants}
                  activeTenantId={data.activeTenantId}
                  action="/api/admin/session/tenant"
                />
              }
              signOut={
                <form action="/api/admin/session/sign-out" method="post">
                  <Button type="submit" variant="ghost" size="sm">
                    Sign out
                  </Button>
                </form>
              }
              themeToggle={<ThemeToggle />}
            >
              {children}
            </ShellFrame>
          )}
        </ThemeProvider>
      </body>
    </html>
  );
}
