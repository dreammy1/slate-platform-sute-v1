import { describe, expect, it } from 'vitest';

import {
  decideTenantSwitch,
  filterShellEntries,
  hydrateShellSession,
  sessionTokenFromCookieHeader,
  tenantSwitchAuditPayload,
  type ShellMembership,
} from './shell-session.ts';
import { createSessionCodec } from './session.ts';

const SECRET = 'shell-session-unit-secret-that-is-long!!';

const MEMBERSHIPS: readonly ShellMembership[] = [
  { tenantId: 'tenant-a', tenantName: 'Tenant A', organizationName: 'Acme' },
  { tenantId: 'tenant-b', tenantName: 'Tenant B', organizationName: 'Acme' },
];

const USER = { id: 'user-1', email: 'ada@example.test', name: 'Ada' };

function stores(
  permissions: readonly string[] = ['users.read'],
  memberships: readonly ShellMembership[] = MEMBERSHIPS,
) {
  return {
    getUser: async (userId: string) => (userId === USER.id ? USER : null),
    listMemberships: async () => memberships,
    getPermissions: async () => permissions,
  };
}

function codecFor(payload: { userId: string; tenantId?: string }) {
  const codec = createSessionCodec({ secret: SECRET });
  return { codec, token: codec.issue(payload) };
}

describe('sessionTokenFromCookieHeader', () => {
  it('reads the session value without throwing on malformed headers', () => {
    expect(sessionTokenFromCookieHeader(undefined)).toBeUndefined();
    expect(sessionTokenFromCookieHeader('')).toBeUndefined();
    expect(sessionTokenFromCookieHeader('no-equals-here')).toBeUndefined();
    expect(sessionTokenFromCookieHeader('other=a; slate_session=token-1; x=b')).toBe('token-1');
    expect(sessionTokenFromCookieHeader('slate_session=; other=a')).toBeUndefined();
  });
});

describe('hydrateShellSession', () => {
  it('hydrates a bound session from a real signed token with fresh reads', async () => {
    const { codec, token } = codecFor({ userId: USER.id, tenantId: 'tenant-a' });
    const hydration = await hydrateShellSession({
      codec,
      stores: stores(['users.read', 'settings.read']),
      cookieHeader: `other=a; slate_session=${token}`,
      requestId: 'req-1',
    });
    expect(hydration).toMatchObject({
      user: USER,
      activeTenantId: 'tenant-a',
      permissions: ['users.read', 'settings.read'],
      requestId: 'req-1',
    });
    if ('tenants' in hydration) expect(hydration.tenants).toHaveLength(2);
  });

  it('refuses an unverifiable token as no-session (never a throw)', async () => {
    const { codec } = codecFor({ userId: USER.id });
    await expect(
      hydrateShellSession({ codec, stores: stores(), cookieHeader: 'slate_session=garbage' }),
    ).resolves.toEqual({ kind: 'unauthenticated', reason: 'no-session' });
  });

  it('refuses an unknown user and an empty membership set', async () => {
    const { codec, token } = codecFor({ userId: 'ghost' });
    await expect(
      hydrateShellSession({ codec, stores: stores(), cookieHeader: `slate_session=${token}` }),
    ).resolves.toEqual({ kind: 'unauthenticated', reason: 'unknown-user' });

    const bound = codecFor({ userId: USER.id, tenantId: 'tenant-a' });
    await expect(
      hydrateShellSession({
        codec: bound.codec,
        stores: stores(['users.read'], []),
        cookieHeader: `slate_session=${bound.token}`,
      }),
    ).resolves.toEqual({ kind: 'unauthenticated', reason: 'no-membership' });
  });

  it('refuses a requested tenant outside membership instead of re-scoping', async () => {
    const { codec, token } = codecFor({ userId: USER.id, tenantId: 'tenant-a' });
    await expect(
      hydrateShellSession({
        codec,
        stores: stores(),
        cookieHeader: `slate_session=${token}`,
        requestedTenantId: 'tenant-b',
      }),
    ).resolves.toEqual({ kind: 'unauthenticated', reason: 'no-membership' });
  });

  it('binds a single membership when the payload carries no tenant', async () => {
    const { codec, token } = codecFor({ userId: USER.id });
    const hydration = await hydrateShellSession({
      codec,
      stores: stores(['users.read'], [MEMBERSHIPS[0]!]),
      cookieHeader: `slate_session=${token}`,
    });
    expect(hydration).toMatchObject({ activeTenantId: 'tenant-a' });
  });

  it('returns the tenardless state for multiple memberships without a binding', async () => {
    const { codec, token } = codecFor({ userId: USER.id });
    await expect(
      hydrateShellSession({ codec, stores: stores(), cookieHeader: `slate_session=${token}` }),
    ).resolves.toMatchObject({ kind: 'tenardless', tenants: MEMBERSHIPS });
  });
});

describe('decideTenantSwitch', () => {
  it('allows a member tenant and refuses anything else with 403', () => {
    expect(
      decideTenantSwitch({
        userId: USER.id,
        previousTenantId: 'tenant-a',
        requestedTenantId: 'tenant-b',
        memberships: MEMBERSHIPS,
      }),
    ).toEqual({ ok: true, tenantId: 'tenant-b' });
    expect(
      decideTenantSwitch({
        userId: USER.id,
        previousTenantId: 'tenant-a',
        requestedTenantId: 'tenant-unknown',
        memberships: MEMBERSHIPS,
      }),
    ).toEqual({ ok: false, status: 403 });
    expect(
      decideTenantSwitch({
        userId: USER.id,
        previousTenantId: 'tenant-a',
        requestedTenantId: '   ',
        memberships: MEMBERSHIPS,
      }),
    ).toEqual({ ok: false, status: 403 });
  });
});

describe('tenantSwitchAuditPayload', () => {
  it('carries identity only: actor, previous and next tenant, request id', () => {
    expect(
      tenantSwitchAuditPayload({
        actorUserId: USER.id,
        previousTenantId: 'tenant-a',
        nextTenantId: 'tenant-b',
        requestId: 'req-9',
      }),
    ).toEqual({
      actorUserId: USER.id,
      previousTenantId: 'tenant-a',
      nextTenantId: 'tenant-b',
      requestId: 'req-9',
    });
  });
});

describe('filterShellEntries', () => {
  it('keeps public entries and filters the rest by the fresh permission set', () => {
    const entries = [
      { id: 'overview', href: '/' },
      { id: 'users', href: '/users', permission: 'users.read' },
      { id: 'settings', href: '/settings', permission: 'settings.read' },
    ];
    expect(filterShellEntries(entries, ['users.read']).map((entry) => entry.id)).toEqual([
      'overview',
      'users',
    ]);
  });
});
