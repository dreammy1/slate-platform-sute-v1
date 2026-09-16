/**
 * The tenant context resolver.
 *
 * One function decides - *before any database query is issued* - whether a
 * request may act on a tenant, and as which tenant:
 *
 * - **401** when there is no authenticated principal, or when neither the
 *   session's active tenant nor the `X-Tenant-Id` header names a tenant.
 * - **403** when the header names a tenant the session is not authorized for
 *   (Master Plan Section 13: the header is never trusted alone), when it
 *   disagrees with the session's active tenant (Section 65 adversarial case),
 *   or when it is malformed.
 * - **200** with a validated {@link TenantContext} otherwise. The context is
 *   the only value application code may hand to the scoped query helper.
 *
 * The resolver is pure: it reads the principal and the header value and
 * returns a result. It never throws for an expected rejection and never
 * touches the database, so a rejected request cannot have leaked a query.
 */

import { isValidTenantId } from '@slate/database';

import { TENANT_ID_HEADER, type AuthenticatedPrincipal } from './principal.ts';

const ERROR_PREFIX = '[slate/tenant-context]';

/** A validated, request-scoped tenant context. */
export interface TenantContext {
  /** The tenant every query of this request is confined to. */
  readonly tenantId: string;
}

/** Outcome of {@link resolveTenantContext}: accept, or reject with a status. */
export type TenantContextResult =
  | { readonly ok: true; readonly status: 200; readonly context: TenantContext }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

/** Inputs of {@link resolveTenantContext}. */
export interface TenantContextInput {
  /** The session principal, or `undefined` when the request is unauthenticated. */
  readonly principal: AuthenticatedPrincipal | undefined;
  /** Raw `X-Tenant-Id` header value; `undefined` when the client sent none. */
  readonly requestedTenantId: string | undefined;
}

/** Thrown by {@link assertTenantContext}; carries the HTTP status to answer with. */
export class TenantContextError extends Error {
  /** HTTP status the caller should answer with (401 or 403). */
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(`${ERROR_PREFIX} ${message}`);
    this.name = 'TenantContextError';
    this.status = status;
  }
}

/**
 * Resolves the request's tenant context, or rejects it with 401/403.
 *
 * Precedence: a session-bound `activeTenantId` wins - the header may only
 * *repeat* it, never override it. Without an active tenant, the header is
 * honored only when it names a tenant in the principal's authorized set.
 */
export function resolveTenantContext(input: TenantContextInput): TenantContextResult {
  const { principal, requestedTenantId } = input;

  if (principal === undefined) {
    return reject(
      401,
      'request is unauthenticated: no session principal is present, refusing to resolve a tenant.',
    );
  }

  const requested =
    requestedTenantId === undefined ? undefined : requestedTenantId.trim().toLowerCase();

  if (requested !== undefined && !isValidTenantId(requested)) {
    return reject(
      403,
      `${TENANT_ID_HEADER}="${requested.slice(0, 64)}" is not a valid tenant id (expected a UUID).`,
    );
  }

  if (principal.activeTenantId !== undefined) {
    const active = principal.activeTenantId.trim().toLowerCase();
    if (!isValidTenantId(active)) {
      return reject(403, 'the session active tenant id is malformed; refusing to serve.');
    }
    if (requested !== undefined && requested !== active) {
      return reject(
        403,
        `${TENANT_ID_HEADER} names tenant "${requested.slice(0, 64)}" but the session is bound to a different tenant.`,
      );
    }
    return accept(active);
  }

  if (requested === undefined) {
    return reject(
      401,
      `no tenant can be resolved: neither the session active tenant nor ${TENANT_ID_HEADER} is present.`,
    );
  }

  const authorized = principal.tenantIds.map((tenantId) => tenantId.trim().toLowerCase());
  if (!authorized.includes(requested)) {
    return reject(
      403,
      `${TENANT_ID_HEADER} names tenant "${requested.slice(0, 64)}" but the session is not authorized for it.`,
    );
  }

  return accept(requested);
}

/**
 * {@link resolveTenantContext} for callers that cannot continue without a
 * context. The thrown error carries the HTTP status to answer with.
 *
 * @throws {@link TenantContextError} when the request must be rejected.
 */
export function assertTenantContext(input: TenantContextInput): TenantContext {
  const result = resolveTenantContext(input);
  if (result.ok) {
    return result.context;
  }
  throw new TenantContextError(result.status, result.reason);
}

function accept(tenantId: string): TenantContextResult {
  return { ok: true, status: 200, context: { tenantId } };
}

function reject(status: 401 | 403, reason: string): TenantContextResult {
  return { ok: false, status, reason };
}
