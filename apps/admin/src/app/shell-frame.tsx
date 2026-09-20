'use client';

/**
 * Client frame around the server-rendered shell (SLATE-302, ADR 010 §1).
 *
 * The shell is presentational; only the active-link resolution needs the
 * browser's location, so this thin client leaf supplies it and renders the
 * server-passed navigation, identity and action nodes unchanged.
 */

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import {
  Shell,
  type ShellNavigationEntry,
  type ShellTenantOption,
  type ShellUser,
} from '@slate/ui';

export interface ShellFrameProps {
  readonly appName: string;
  readonly navigation: readonly ShellNavigationEntry[];
  readonly user: ShellUser;
  readonly tenantName: string;
  readonly tenants: readonly ShellTenantOption[];
  readonly activeTenantId: string;
  readonly requestId: string | undefined;
  readonly tenantSwitcher: ReactNode;
  readonly signOut: ReactNode;
  readonly themeToggle: ReactNode;
  readonly children: ReactNode;
}

export function ShellFrame({ navigation, ...rest }: ShellFrameProps) {
  const pathname = usePathname();
  // The most specific matching entry wins, so `/tenants/<id>` lights up `/tenants`.
  const activePath =
    navigation.find((entry) => entry.href !== '/' && pathname.startsWith(entry.href))?.href ??
    pathname;

  return <Shell {...rest} navigation={navigation} activePath={activePath} />;
}
