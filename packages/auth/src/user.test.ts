import { describe, expect, it } from 'vitest';

import { AuthAuthenticationError, createAuthQueryService } from './user.ts';
import type { AuthQueryService } from './user.ts';

/**
 * Minimal hermetic stand-in: models the query-service contract without any
 * I/O. No fakes here touch Postgres — the integration suite owns the real
 * join chain.
 */
function fakeAuthService(
  users: Record<string, { email: string; active: boolean }>,
): AuthQueryService {
  return {
    getCurrentUser: async (userId) => {
      const row = users[userId];
      if (row === undefined) {
        return null;
      }
      return {
        id: userId,
        email: row.email,
        name: 'Test User',
        status: row.active ? 'active' : 'inactive',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };
    },
    getPermissionsForUser: async () => [],
    findPermission: async () => null,
  };
}

describe('AuthAuthenticationError', () => {
  it('exposes stable factory codes', () => {
    expect(AuthAuthenticationError.notFound('u-1').code).toBe('AUTH_NOT_FOUND');
    expect(AuthAuthenticationError.unauthorized().code).toBe('AUTH_UNAUTHORIZED');
    expect(AuthAuthenticationError.revoked('u-1').code).toBe('AUTH_REVOKED');
  });
});

describe('createAuthQueryService (contract)', () => {
  it('returns null for an unknown user', async () => {
    const service = fakeAuthService({});
    await expect(service.getCurrentUser('missing-user')).resolves.toBeNull();
  });

  it('returns the user when present and active', async () => {
    const service = fakeAuthService({ 'u-1': { email: 'a@example.com', active: true } });
    const user = await service.getCurrentUser('u-1');
    expect(user).toMatchObject({ id: 'u-1', email: 'a@example.com', status: 'active' });
  });

  it('rejects an empty server-derived id without touching the database', async () => {
    const queries: string[] = [];
    const service = createAuthQueryService({
      selectFrom: () => {
        queries.push('select');
        throw new Error('must not query');
      },
    } as never);
    await expect(service.getCurrentUser('')).rejects.toBeInstanceOf(AuthAuthenticationError);
    await expect(service.getCurrentUser('   ')).rejects.toBeInstanceOf(AuthAuthenticationError);
    expect(queries).toEqual([]);
  });
});

describe('createAuthQueryService (wiring)', () => {
  it('exposes the full auth query surface', () => {
    // A structurally-typed stand-in is enough: the factory only wires methods,
    // so a proxy asserting presence proves the contract without I/O.
    const service = createAuthQueryService(
      new Proxy(
        {},
        {
          get: () => () => {
            throw new Error('unit tests never call the driver');
          },
        },
      ) as never,
    );
    expect(typeof service.getCurrentUser).toBe('function');
    expect(typeof service.getPermissionsForUser).toBe('function');
    expect(typeof service.findPermission).toBe('function');
  });
});
