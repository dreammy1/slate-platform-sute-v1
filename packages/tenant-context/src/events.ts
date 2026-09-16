/**
 * Tenant lifecycle events, emitted through the `@slate/observability` logger.
 *
 * SLATE-201 event contract: a resolved context emits `tenant.selected` with
 * `{ tenantId, organizationId }`. The in-process event bus arrives with
 * SLATE-203; until then the structured logger *is* the event surface - every
 * record passes the logger's redaction layer (Master Plan Section 61), so the
 * event payload can never smuggle a secret into a log store.
 */

import type { Logger } from '@slate/observability';

const ERROR_PREFIX = '[slate/tenant-context]';

/** Emitted when a request resolves and binds to a tenant. */
export const TENANT_SELECTED_EVENT = 'tenant.selected' as const;

/** Payload of the {@link TENANT_SELECTED_EVENT} event. */
export interface TenantSelectedPayload {
  /** The tenant the request is bound to. */
  readonly tenantId: string;
  /** The organization owning the tenant (from `resolveTenantOrganization`). */
  readonly organizationId: string;
  /** Optional request correlation id. */
  readonly requestId?: string | undefined;
}

/**
 * Emits `tenant.selected` with `{ tenantId, organizationId }` at `info` on the
 * project logger, under the `event` field so collectors can route it.
 */
export function emitTenantSelected(logger: Logger, payload: TenantSelectedPayload): void {
  if (payload.tenantId.trim() === '' || payload.organizationId.trim() === '') {
    throw new Error(
      `${ERROR_PREFIX} ${TENANT_SELECTED_EVENT} requires both tenantId and organizationId.`,
    );
  }
  logger.info(TENANT_SELECTED_EVENT, {
    event: TENANT_SELECTED_EVENT,
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    ...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
  });
}
