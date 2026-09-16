import { describe, expect, it } from 'vitest';

import { TenantContextError, assertTenantContext, resolveTenantContext } from './context.ts';
import type { AuthenticatedPrincipal } from './principal.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function principalFor(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return { userId: 'user-1', tenantIds: [TENANT_A, TENANT_B], ...overrides };
}

describe('resolveTenantContext', () => {
  it('rejects an unauthenticated request with 401', () => {
    const result = resolveTenantContext({ principal: undefined, requestedTenantId: TENANT_A });
    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: expect.stringMatching(/unauthenticated/),
    });
  });

  it('rejects with 401 when no tenant is resolvable from header or session', () => {
    const result = resolveTenantContext({
      principal: principalFor({ tenantIds: [], activeTenantId: undefined }),
      requestedTenantId: undefined,
    });
    expect(result).toEqual({ ok: false, status: 401, reason: expect.any(String) });
  });

  it('accepts the header when the session authorizes the tenant', () => {
    const result = resolveTenantContext({
      principal: principalFor({ tenantIds: [TENANT_A] }),
      requestedTenantId: ` ${TENANT_A.toUpperCase()} `,
    });
    expect(result).toEqual({ ok: true, status: 200, context: { tenantId: TENANT_A } });
  });

  it('defaults to the session active tenant when no header is present', () => {
    const result = resolveTenantContext({
      principal: principalFor({ activeTenantId: TENANT_B, tenantIds: [TENANT_B] }),
      requestedTenantId: undefined,
    });
    expect(result).toEqual({ ok: true, status: 200, context: { tenantId: TENANT_B } });
  });

  it('accepts a header that repeats the session active tenant', () => {
    const result = resolveTenantContext({
      principal: principalFor({ activeTenantId: TENANT_A }),
      requestedTenantId: TENANT_A,
    });
    expect(result).toEqual({ ok: true, status: 200, context: { tenantId: TENANT_A } });
  });

  it('rejects a foreign X-Tenant-Id with 403 while the session is bound to another tenant', () => {
    const result = resolveTenantContext({
      principal: principalFor({ activeTenantId: TENANT_A, tenantIds: [TENANT_A] }),
      requestedTenantId: TENANT_B,
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: expect.stringMatching(/bound to a different tenant/),
    });
  });

  it('rejects with 403 a header naming a tenant outside the authorized set', () => {
    const foreign = '33333333-3333-4333-8333-333333333333';
    const result = resolveTenantContext({
      principal: principalFor({ tenantIds: [TENANT_A] }),
      requestedTenantId: foreign,
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: expect.stringMatching(/not authorized/),
    });
  });

  it('rejects with 403 a malformed header value', () => {
    for (const malformed of ['not-a-uuid', '', `${TENANT_A}; drop table tenant`]) {
      const result = resolveTenantContext({
        principal: principalFor({ tenantIds: [TENANT_A] }),
        requestedTenantId: malformed,
      });
      expect(result.ok).toBe(false);
      expect(result.ok ? undefined : result.status).toBe(403);
    }
  });

  it('rejects with 403 a malformed session active tenant id', () => {
    const result = resolveTenantContext({
      principal: principalFor({ activeTenantId: 'garbage' }),
      requestedTenantId: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.status).toBe(403);
  });

  it('rejects with 403 a header the session did not authorize even when the session has tenants', () => {
    const foreign = '44444444-4444-4444-8444-444444444444';
    const result = resolveTenantContext({
      principal: principalFor({ tenantIds: [TENANT_A, TENANT_B] }),
      requestedTenantId: foreign,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.status).toBe(403);
  });
});

describe('assertTenantContext', () => {
  it('returns the context on success', () => {
    expect(
      assertTenantContext({
        principal: principalFor({ tenantIds: [TENANT_A] }),
        requestedTenantId: TENANT_A,
      }),
    ).toEqual({ tenantId: TENANT_A });
  });

  it('throws a TenantContextError carrying the status on rejection', () => {
    try {
      assertTenantContext({
        principal: principalFor({ activeTenantId: TENANT_A }),
        requestedTenantId: TENANT_B,
      });
      expect.unreachable('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantContextError);
      expect((error as TenantContextError).status).toBe(403);
      expect((error as Error).message).toContain('[slate/tenant-context]');
    }
  });
});
