import { describe, expect, it } from 'vitest';

import { ownershipPermissionsFor } from './ownership.ts';
import type { OwnershipCheck } from './ownership.ts';

const CHECK: OwnershipCheck = {
  userId: 'user-1',
  tenantId: '11111111-1111-4111-8111-111111111111',
  resourceType: 'document',
  resourceId: 'doc-1',
};

describe('ownershipPermissionsFor', () => {
  it('returns [] when no policy is installed', () => {
    expect(ownershipPermissionsFor(CHECK)).toEqual([]);
  });

  it('returns [] when the user owns nothing', () => {
    expect(ownershipPermissionsFor(CHECK, { getOwnerPermissions: () => null })).toEqual([]);
  });

  it('returns the sorted owner-level keys when the user owns the resource', () => {
    const keys = ownershipPermissionsFor(CHECK, {
      getOwnerPermissions: () => ['document.delete', 'document.read'],
    });
    expect(keys).toEqual(['document.delete', 'document.read']);
  });

  it('rejects empty server-derived ids before consulting the policy', () => {
    expect(() =>
      ownershipPermissionsFor({ ...CHECK, userId: '' }, { getOwnerPermissions: () => [] }),
    ).toThrow(/server-derived/);
    expect(() =>
      ownershipPermissionsFor({ ...CHECK, resourceType: '  ' }, { getOwnerPermissions: () => [] }),
    ).toThrow(/resourceType/);
  });
});
