import { describe, expect, it } from 'vitest';

import {
  ADMIN_PERMISSIONS,
  AdminAuthorizationError,
  AdminEscalationError,
  assertNoEscalation,
  findEscalatedPermissions,
  isGrantWithinAuthority,
  requirePermission,
  type AdminActor,
} from './permissions.ts';

const ACTOR: AdminActor = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  permissions: ['users.read', 'roles.manage', 'tenants.read'],
};

describe('requirePermission', () => {
  it('passes when the actor holds the key', () => {
    expect(() => requirePermission(ACTOR, ADMIN_PERMISSIONS.userRead)).not.toThrow();
    expect(() => requirePermission(ACTOR, ADMIN_PERMISSIONS.roleManage)).not.toThrow();
  });

  it('refuses with 403 when the actor lacks the key', () => {
    expect(() => requirePermission(ACTOR, ADMIN_PERMISSIONS.tenantManage)).toThrow(
      AdminAuthorizationError,
    );
    try {
      requirePermission(ACTOR, ADMIN_PERMISSIONS.tenantManage);
    } catch (error) {
      expect((error as { status?: number }).status).toBe(403);
    }
  });
});

describe('findEscalatedPermissions', () => {
  it('returns only the granted keys the actor does not hold, sorted and unique', () => {
    expect(
      findEscalatedPermissions(['users.read', 'tenants.manage', 'tenants.manage'], ['users.read']),
    ).toEqual(['tenants.manage']);
    expect(findEscalatedPermissions(['users.read'], ACTOR.permissions)).toEqual([]);
    expect(findEscalatedPermissions([], ACTOR.permissions)).toEqual([]);
  });
});

describe('isGrantWithinAuthority and assertNoEscalation', () => {
  it('accepts a grant that stays within the actor authority', () => {
    expect(isGrantWithinAuthority(['users.read'], ACTOR.permissions)).toBe(true);
    expect(() => assertNoEscalation(['users.read'], ACTOR.permissions)).not.toThrow();
  });

  it('refuses a grant that outranks the actor and names every escalated key', () => {
    const granted = ['tenants.manage', 'settings.manage'];
    expect(isGrantWithinAuthority(granted, ACTOR.permissions)).toBe(false);
    expect(findEscalatedPermissions(granted, ACTOR.permissions)).toEqual([
      'settings.manage',
      'tenants.manage',
    ]);
    expect(() => assertNoEscalation(granted, ACTOR.permissions)).toThrow(AdminEscalationError);
    try {
      assertNoEscalation(granted, ACTOR.permissions);
    } catch (error) {
      const escalation = error as AdminEscalationError;
      expect(escalation.status).toBe(403);
      expect(escalation.escalated).toEqual(['settings.manage', 'tenants.manage']);
    }
  });
});
