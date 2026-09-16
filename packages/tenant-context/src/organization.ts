/**
 * Resolves the organization row that owns a tenant.
 *
 * SLATE-201 contract: the context layer resolves the owning `organization`
 * row so the `tenant.selected` event can carry `{ tenantId, organizationId }`
 * and downstream code never has to trust a client-supplied organization id
 * (Master Plan Section 13). A tenant without an owning organization is a data
 * integrity fault and fails loudly instead of being served.
 */

import type { Kysely } from 'kysely';

import { isValidTenantId, type Database } from '@slate/database';

const ERROR_PREFIX = '[slate/tenant-context]';

/** A tenant together with the organization that owns it. */
export interface TenantOrganization {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
}

/**
 * Reads the owning organization of `tenantId` (tenant ⨝ organization).
 *
 * @throws when `tenantId` is not a UUID, or when no tenant/organization pair
 *   exists for it - a missing row is never silently tolerated.
 */
export async function resolveTenantOrganization(
  db: Kysely<Database>,
  tenantId: string,
): Promise<TenantOrganization> {
  const id = tenantId.trim().toLowerCase();
  if (!isValidTenantId(id)) {
    throw new Error(
      `${ERROR_PREFIX} "${tenantId.slice(0, 64)}" is not a valid tenant id; refusing to resolve an owning organization.`,
    );
  }

  const row = await db
    .selectFrom('tenant')
    .innerJoin('organization', 'organization.id', 'tenant.organization_id')
    .select([
      'tenant.id as tenantId',
      'tenant.slug as tenantSlug',
      'organization.id as organizationId',
      'organization.slug as organizationSlug',
      'organization.name as organizationName',
    ])
    .where('tenant.id', '=', id)
    .executeTakeFirst();

  if (row === undefined) {
    throw new Error(
      `${ERROR_PREFIX} tenant "${id}" has no owning organization row; refusing to serve the request.`,
    );
  }
  return row;
}
