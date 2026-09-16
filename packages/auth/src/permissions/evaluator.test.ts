import { describe, expect, it, vi } from 'vitest';

import { PermissionAuthorizationError } from './errors.ts';
import { createPermissionEvaluator } from './evaluator.ts';
import type { OwnershipInput } from './evaluator.ts';
import type { PermissionQueryService } from './query-service.ts';
import type { TenantId, UserId } from '../types.ts';

const USER = 'user-1';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/**
 * Fake query service modelling the tenant-pinned join chain explicitly: keys
 * are stored per tenant, and a lookup only ever reads its own tenant's set.
 */
function fakeQueryService(grants: Record<string, Record<string, readonly string[]>>) {
  let calls = 0;
  const service: PermissionQueryService & { calls: number } = {
    get calls() {
      return calls;
    },
    getPermissionsForUser: async (userId: UserId, tenantId: TenantId) => {
      calls += 1;
      return [...(grants[tenantId]?.[userId] ?? [])].sort();
    },
    findPermission: async (tenantId: TenantId, key: string) => {
      const tenantKeys = new Set<string>();
      for (const userKeys of Object.values(grants[tenantId] ?? {})) {
        for (const candidate of userKeys) {
          tenantKeys.add(candidate);
        }
      }
      return tenantKeys.has(key) ? { id: `${tenantId}:${key}` } : null;
    },
  };
  return service;
}

function evaluatorFor(grants: Record<string, Record<string, readonly string[]>>) {
  return createPermissionEvaluator({ queryService: fakeQueryService(grants) });
}

describe('permission evaluator (unit)', () => {
  it('returns the distinct, sorted permission set for a user in a tenant', async () => {
    const evaluator = evaluatorFor({
      [TENANT_A]: { [USER]: ['users.write', 'users.read', 'users.read'] },
    });
    const set = await evaluator.getPermissionsForUser(USER, TENANT_A);
    expect(set).toEqual({
      tenantId: TENANT_A,
      userId: USER,
      permissionKeys: ['users.read', 'users.write'],
    });
  });

  it('a tenant’s users cannot see another tenant’s permissions (isolation)', async () => {
    const evaluator = evaluatorFor({
      [TENANT_A]: { [USER]: ['users.read'] },
      [TENANT_B]: { [USER]: ['billing.refund'] },
    });
    await expect(evaluator.getPermissionsForUser(USER, TENANT_A)).resolves.toEqual({
      tenantId: TENANT_A,
      userId: USER,
      permissionKeys: ['users.read'],
    });
    const foreign = await evaluator.hasPermission({
      userId: USER,
      tenantId: TENANT_A,
      permission: 'billing.refund',
    });
    expect(foreign).toBe(false);
    const own = await evaluator.hasPermission({
      userId: USER,
      tenantId: TENANT_B,
      permission: 'billing.refund',
    });
    expect(own).toBe(true);
  });

  it('hasPermission is false (never throws) for unknown keys', async () => {
    const evaluator = evaluatorFor({ [TENANT_A]: { [USER]: ['users.read'] } });
    const allowed = await evaluator.hasPermission({
      userId: USER,
      tenantId: TENANT_A,
      permission: 'nope.missing',
    });
    expect(allowed).toBe(false);
  });
});

describe('permission evaluator no-stale-grants (Section 65)', () => {
  it('re-queries on every call: a mid-session revocation takes effect immediately', async () => {
    const grants: Record<string, Record<string, readonly string[]>> = {
      [TENANT_A]: { [USER]: ['users.read', 'users.write'] },
    };
    const service = fakeQueryService(grants);
    const evaluator = createPermissionEvaluator({ queryService: service });

    const before = await evaluator.hasPermission({
      userId: USER,
      tenantId: TENANT_A,
      permission: 'users.write',
    });
    expect(before).toBe(true);

    grants[TENANT_A] = { [USER]: ['users.read'] };

    const after = await evaluator.hasPermission({
      userId: USER,
      tenantId: TENANT_A,
      permission: 'users.write',
    });
    expect(after).toBe(false);
    expect(service.calls).toBe(2);
  });

  it('assertPermission throws without leaking the key', async () => {
    const evaluator = evaluatorFor({ [TENANT_A]: { [USER]: ['users.read'] } });
    const failure = evaluator.assertPermission({
      userId: USER,
      tenantId: TENANT_A,
      permission: 'users.write',
    });
    await expect(failure).rejects.toBeInstanceOf(PermissionAuthorizationError);
    await expect(failure).rejects.toThrow(/not authorized/);
  });

  it('rejects empty server-derived ids before querying (Section 13)', async () => {
    const service = fakeQueryService({ [TENANT_A]: { [USER]: ['users.read'] } });
    const evaluator = createPermissionEvaluator({ queryService: service });
    await expect(evaluator.getPermissionsForUser('', TENANT_A)).rejects.toThrow(/server-derived/);
    await expect(evaluator.getPermissionsForUser(USER, '  ')).rejects.toThrow(/server-derived/);
    expect(service.calls).toBe(0);
  });

  it('does not cache: the query service is hit once per evaluator call', async () => {
    const service = fakeQueryService({ [TENANT_A]: { [USER]: ['users.read'] } });
    const query = vi.spyOn(service, 'getPermissionsForUser');
    const evaluator = createPermissionEvaluator({ queryService: service });
    const params = { userId: USER, tenantId: TENANT_A, permission: 'users.read' };
    await evaluator.hasPermission(params);
    await evaluator.hasPermission(params);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('permission evaluator ownership', () => {
  it('unions owner-level permissions on top of role-based keys', async () => {
    const evaluator = evaluatorFor({ [TENANT_A]: { [USER]: ['users.read'] } });
    const ownership: OwnershipInput = {
      resourceType: 'document',
      resourceId: 'doc-1',
      policy: { getOwnerPermissions: () => ['document.delete'] },
    };
    const set = await evaluator.getPermissionsForUser(USER, TENANT_A, ownership);
    expect(set.permissionKeys).toEqual(['document.delete', 'users.read']);
    const allowed = await evaluator.hasPermission({
      userId: USER,
      tenantId: TENANT_A,
      permission: 'document.delete',
      ownership,
    });
    expect(allowed).toBe(true);
  });

  it('a non-owner gains nothing from the ownership policy', async () => {
    const evaluator = evaluatorFor({ [TENANT_A]: { [USER]: ['users.read'] } });
    const ownership: OwnershipInput = {
      resourceType: 'document',
      resourceId: 'doc-9',
      policy: { getOwnerPermissions: () => null },
    };
    await expect(evaluator.getPermissionsForUser(USER, TENANT_A, ownership)).resolves.toEqual({
      tenantId: TENANT_A,
      userId: USER,
      permissionKeys: ['users.read'],
    });
  });
});
