/**
 * Tenant management (SLATE-302, ADR 010 §2).
 *
 * Reads are confined to the tenants the actor is a member of; a tenant the actor
 * cannot reach is a not-found, never a re-scope (Section 13). Writes run
 * `authz → write + audit in one transaction`, preserving the SLATE-203 pipeline
 * semantics without adding a platform route (ADR 010 §6).
 *
 * Isolation note: queries through the scoped helper never join a second
 * tenant-owned table (the forced `tenant_id` predicate is unqualified), so roles
 * are resolved with a separate scoped read and stitched in memory.
 */

import type { Kysely } from 'kysely';

import { createTenantDatabase, type Database } from '@slate/database';

import { recordAudit } from './audit.ts';
import { ADMIN_PERMISSIONS, requirePermission, type AdminActor } from './permissions.ts';

/** A tenant row the admin UI renders. Tenant-authored text stays text. */
export interface TenantSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly memberCount: number;
}

/** A member of a tenant, as the detail view shows it. */
export interface TenantMember {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly roleId: string | null;
  readonly roleName: string | null;
}

/** The detail view's payload. */
export interface TenantDetail {
  readonly tenant: TenantSummary;
  readonly members: readonly TenantMember[];
}

/** Raised when a tenant is not reachable by the actor (denial, not re-scope). */
export class TenantNotFoundError extends Error {
  readonly status = 404;

  constructor() {
    super("The tenant was not found in the acting user's memberships (ADR 010 §2).");
    this.name = 'TenantNotFoundError';
  }
}

/** Raised when a create/rename input is invalid. */
export class TenantInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'TenantInputError';
  }
}

/** Lowercase words separated by single hyphens; the slug contract. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertTenantInput(
  name: unknown,
  slug: unknown,
): { readonly name: string; readonly slug: string } {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedSlug = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
  if (trimmedName.length < 1 || trimmedName.length > 120) {
    throw new TenantInputError('A tenant name must be between 1 and 120 characters.');
  }
  if (trimmedSlug.length > 63 || !SLUG_PATTERN.test(trimmedSlug)) {
    throw new TenantInputError(
      'A tenant slug must be lowercase words separated by single hyphens.',
    );
  }
  return { name: trimmedName, slug: trimmedSlug };
}

/** The tenant admin surface. */
export interface TenantAdminService {
  listTenants(actor: AdminActor): Promise<readonly TenantSummary[]>;
  createTenant(
    actor: AdminActor,
    input: { readonly name: unknown; readonly slug: unknown },
  ): Promise<TenantSummary>;
  getTenantDetail(actor: AdminActor, tenantId: string): Promise<TenantDetail>;
}

/** Wires the tenant admin service to a database client. */
export function createTenantAdminService(db: Kysely<Database>): TenantAdminService {
  async function memberTenantIds(userId: string): Promise<readonly string[]> {
    const rows = await db
      .selectFrom('tenant_membership')
      .select('tenant_id')
      .where('app_user_id', '=', userId)
      .execute();
    return rows.map((row) => row.tenant_id);
  }

  async function memberCount(tenantId: string): Promise<number> {
    const rows = await createTenantDatabase(db, tenantId)
      .selectFrom('tenant_membership')
      .select('id')
      .execute();
    return rows.length;
  }

  async function summaryFor(tenantId: string): Promise<TenantSummary> {
    const row = await db
      .selectFrom('tenant')
      .innerJoin('organization', 'organization.id', 'tenant.organization_id')
      .where('tenant.id', '=', tenantId)
      .select([
        'tenant.id as id',
        'tenant.name as name',
        'tenant.slug as slug',
        'tenant.organization_id as organizationId',
        'organization.name as organizationName',
      ])
      .executeTakeFirst();
    if (row === undefined) throw new TenantNotFoundError();
    return { ...row, memberCount: await memberCount(tenantId) };
  }

  return {
    async listTenants(actor) {
      requirePermission(actor, ADMIN_PERMISSIONS.tenantRead);
      const tenantIds = await memberTenantIds(actor.userId);
      if (tenantIds.length === 0) return [];
      const rows = await db
        .selectFrom('tenant')
        .innerJoin('organization', 'organization.id', 'tenant.organization_id')
        .where('tenant.id', 'in', tenantIds)
        .select([
          'tenant.id as id',
          'tenant.name as name',
          'tenant.slug as slug',
          'tenant.organization_id as organizationId',
          'organization.name as organizationName',
        ])
        .orderBy('tenant.name')
        .execute();
      return Promise.all(
        rows.map(async (row) => ({ ...row, memberCount: await memberCount(row.id) })),
      );
    },

    async createTenant(actor, input) {
      requirePermission(actor, ADMIN_PERMISSIONS.tenantManage);
      const { name, slug } = assertTenantInput(input.name, input.slug);
      // The organization is resolved from the actor's active tenant, server-side.
      const home = await db
        .selectFrom('tenant')
        .innerJoin('organization', 'organization.id', 'tenant.organization_id')
        .where('tenant.id', '=', actor.tenantId)
        .select([
          'tenant.organization_id as organizationId',
          'organization.name as organizationName',
        ])
        .executeTakeFirst();
      if (home === undefined) throw new TenantNotFoundError();

      return db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto('tenant')
          .values({ organization_id: home.organizationId, name, slug })
          .returning(['id', 'name', 'slug', 'organization_id'])
          .executeTakeFirstOrThrow();
        await recordAudit(trx, {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'admin.tenant.created',
          resourceType: 'tenant',
          resourceId: created.id,
          payload: { name, slug, organizationId: home.organizationId },
        });
        return {
          id: created.id,
          name: created.name,
          slug: created.slug,
          organizationId: created.organization_id,
          organizationName: home.organizationName,
          memberCount: 0,
        };
      });
    },

    async getTenantDetail(actor, tenantId) {
      requirePermission(actor, ADMIN_PERMISSIONS.tenantRead);
      const tenantIds = await memberTenantIds(actor.userId);
      if (!tenantIds.includes(tenantId)) throw new TenantNotFoundError();

      const tenant = await summaryFor(tenantId);
      const memberRows = await createTenantDatabase(db, tenantId)
        .selectFrom('tenant_membership')
        .innerJoin('app_user', 'app_user.id', 'tenant_membership.app_user_id')
        .select([
          'app_user.id as userId',
          'app_user.email as email',
          'app_user.display_name as name',
          'tenant_membership.role_id as roleId',
        ])
        .orderBy('app_user.email')
        .execute();
      const roles = await createTenantDatabase(db, tenantId)
        .selectFrom('role')
        .select(['id', 'name'])
        .execute();
      const roleNames = new Map(roles.map((role) => [role.id, role.name]));

      return {
        tenant,
        members: memberRows.map((member) => ({
          userId: member.userId,
          email: member.email,
          name: member.name,
          roleId: member.roleId,
          roleName: member.roleId === null ? null : (roleNames.get(member.roleId) ?? null),
        })),
      };
    },
  };
}
