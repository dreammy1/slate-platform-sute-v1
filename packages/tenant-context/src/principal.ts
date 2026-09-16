/**
 * The authenticated principal the context layer trusts.
 *
 * Master Plan Section 13: tenant and organization ids come from the *session*,
 * never from a client header alone. The principal is produced by the
 * authentication layer (SLATE-202); until then it is a plain, injectable value
 * object, so the context rules below are testable without any auth transport.
 */

/**
 * Header a client may use to name the tenant it wants to act on. Only ever
 * honored when the session's principal authorizes it
 * ({@link AuthenticatedPrincipal}).
 */
export const TENANT_ID_HEADER = 'x-tenant-id';

/** A session that authentication has already vouched for. */
export interface AuthenticatedPrincipal {
  /** Server-derived user identity (never a client-supplied value). */
  readonly userId: string;
  /**
   * Tenants the session is authorized for. This set - not the request - is
   * the only source of tenant authorization (Master Plan Section 13).
   */
  readonly tenantIds: readonly string[];
  /**
   * Tenant the session is currently bound to, when the session flow pins one.
   * When set, any `X-Tenant-Id` naming a different tenant is the Master Plan
   * Section 65 adversarial case and is rejected with 403.
   */
  readonly activeTenantId?: string | undefined;
}
