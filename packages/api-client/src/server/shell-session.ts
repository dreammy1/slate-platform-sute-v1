/**
 * Pure session helpers for the SLATE-301 shell (ADR 009).
 *
 * Everything here is injectable and dependency-light so the app server zones
 * and the unit suite share the exact rules: cookie parsing that never throws,
 * tenant resolution that never re-scopes, audit payloads that carry no tenant
 * data, and a switch verdict the server action enforces.
 */

import { SESSION_COOKIE_NAME, type SessionCodec } from './session.ts';

/** One membership row the server resolved: tenant identity plus display name. */
export interface ShellMembership {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly organizationName: string;
}

/** Server-resolved identity for the profile tray (no permission keys). */
export interface ShellIdentity {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/** What `requireSession()` hands the layout: data only, never authority. */
export interface ShellSession {
  readonly user: ShellIdentity;
  readonly tenants: readonly ShellMembership[];
  readonly activeTenantId: string;
  readonly permissions: readonly string[];
  readonly requestId: string | undefined;
}

/** The tenardless state: signed in, but no tenant bound (ADR 009 §1). */
export interface ShellTenardless {
  readonly kind: 'tenardless';
  readonly user: ShellIdentity;
  readonly tenants: readonly ShellMembership[];
  readonly requestId: string | undefined;
}

/** Why hydration stopped before a session: the layout's redirect decision. */
export type ShellUnauthenticatedReason = 'no-session' | 'unknown-user' | 'no-membership';

/** The unauthenticated state: nothing tenant-shaped leaves the server. */
export interface ShellUnauthenticated {
  readonly kind: 'unauthenticated';
  readonly reason: ShellUnauthenticatedReason;
}

/** Every hydration outcome: a session, a tenardless state, or a redirect. */
export type ShellHydration = ShellSession | ShellTenardless | ShellUnauthenticated;

/** Dependencies the app server zone injects (real DB reads in production). */
export interface ShellSessionStores {
  readonly getUser: (userId: string) => Promise<ShellIdentity | null>;
  readonly listMemberships: (userId: string) => Promise<readonly ShellMembership[]>;
  readonly getPermissions: (userId: string, tenantId: string) => Promise<readonly string[]>;
}

/** Options for `hydrateShellSession`. */
export interface HydrateShellSessionOptions {
  readonly codec: Pick<SessionCodec, 'verify'>;
  readonly stores: ShellSessionStores;
  readonly cookieHeader: string | undefined;
  readonly requestedTenantId?: string | undefined;
  readonly requestId?: string | undefined;
}

/** Options for `decideTenantSwitch`. */
export interface DecideTenantSwitchOptions {
  readonly userId: string;
  readonly previousTenantId: string;
  readonly requestedTenantId: string;
  readonly memberships: readonly ShellMembership[];
}

/** The switch verdict: re-issue with this binding, or refuse with 403. */
export type TenantSwitchDecision =
  { readonly ok: true; readonly tenantId: string } | { readonly ok: false; readonly status: 403 };

/** Reads the session cookie value without throwing (never an exception). */
export function sessionTokenFromCookieHeader(header: string | undefined): string | undefined {
  if (typeof header !== 'string' || header === '') return undefined;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(index + 1).trim();
    if (value === '') return undefined;
    return value;
  }
  return undefined;
}

/** Hydrates the shell session from a cookie header (ADR 009 section 1). */
export async function hydrateShellSession(
  options: HydrateShellSessionOptions,
): Promise<ShellHydration> {
  const token = sessionTokenFromCookieHeader(options.cookieHeader);
  if (token === undefined) return { kind: 'unauthenticated', reason: 'no-session' };
  const payload = options.codec.verify(token);
  if (payload === undefined) return { kind: 'unauthenticated', reason: 'no-session' };

  const user = await options.stores.getUser(payload.userId);
  if (user === null) return { kind: 'unauthenticated', reason: 'unknown-user' };

  const memberships = await options.stores.listMemberships(payload.userId);
  if (memberships.length === 0) return { kind: 'unauthenticated', reason: 'no-membership' };

  const requested = options.requestedTenantId?.trim().toLowerCase();
  if (requested !== undefined && requested !== '') {
    const memberIds = memberships.map((membership) => membership.tenantId.toLowerCase());
    if (!memberIds.includes(requested)) return { kind: 'unauthenticated', reason: 'no-membership' };
    if (payload.tenantId !== undefined && payload.tenantId.toLowerCase() !== requested) {
      return { kind: 'unauthenticated', reason: 'no-membership' };
    }
    const activeTenantId =
      memberships.find((membership) => membership.tenantId.toLowerCase() === requested)?.tenantId ??
      requested;
    const permissions = await options.stores.getPermissions(payload.userId, activeTenantId);
    return {
      user,
      tenants: memberships,
      activeTenantId,
      permissions,
      requestId: options.requestId,
    };
  }

  if (payload.tenantId !== undefined) {
    const bound = memberships.find(
      (membership) => membership.tenantId.toLowerCase() === payload.tenantId!.toLowerCase(),
    );
    if (bound === undefined) return { kind: 'unauthenticated', reason: 'no-membership' };
    const permissions = await options.stores.getPermissions(payload.userId, bound.tenantId);
    return {
      user,
      tenants: memberships,
      activeTenantId: bound.tenantId,
      permissions,
      requestId: options.requestId,
    };
  }

  if (memberships.length === 1 && memberships[0] !== undefined) {
    const bound = memberships[0];
    const permissions = await options.stores.getPermissions(payload.userId, bound.tenantId);
    return {
      user,
      tenants: memberships,
      activeTenantId: bound.tenantId,
      permissions,
      requestId: options.requestId,
    };
  }

  return { kind: 'tenardless', user, tenants: memberships, requestId: options.requestId };
}

/** Decides a switch from re-read membership (ADR 009 section 3). */
export function decideTenantSwitch(options: DecideTenantSwitchOptions): TenantSwitchDecision {
  const requested = options.requestedTenantId.trim().toLowerCase();
  if (requested === '') return { ok: false, status: 403 };
  const match = options.memberships.find(
    (membership) => membership.tenantId.toLowerCase() === requested,
  );
  if (match === undefined) return { ok: false, status: 403 };
  return { ok: true, tenantId: match.tenantId };
}

/** Audit payload for a switch: identity only, no tenant data (Section 61). */
export function tenantSwitchAuditPayload(options: {
  readonly actorUserId: string;
  readonly previousTenantId: string;
  readonly nextTenantId: string;
  readonly requestId: string | undefined;
}): Readonly<Record<string, string>> {
  return {
    actorUserId: options.actorUserId,
    previousTenantId: options.previousTenantId,
    nextTenantId: options.nextTenantId,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  };
}

/** Guard helper: entries without a key are public; the rest need membership. */
export function filterShellEntries<TEntry extends { readonly permission?: string | undefined }>(
  entries: readonly TEntry[],
  permissions: readonly string[],
): readonly TEntry[] {
  return entries.filter(
    (entry) => entry.permission === undefined || permissions.includes(entry.permission),
  );
}
