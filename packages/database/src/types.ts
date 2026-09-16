/**
 * The typed schema contract of the Phase 2 core tables.
 *
 * One interface per table, one `Database` map for Kysely: every query the
 * platform writes is checked against these column types, so a renamed column
 * breaks the build instead of production. The shapes mirror the raw SQL in
 * `src/migrations/` - the SQL files stay the single source of truth for the
 * physical schema, and this file is the single source of truth for the types.
 *
 * Master Plan reference: Section 14 (core domain model),
 * docs/phase2-agent-tasks.md (SLATE-200 database contract).
 */

import type { Generated } from 'kysely';

/** Root entity that owns tenants (billing, legal identity). Never tenant-scoped. */
export interface OrganizationTable {
  readonly id: Generated<string>;
  readonly name: string;
  readonly slug: string;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

/** One tenant (workspace) inside an organization. Identified by its own id. */
export interface TenantTable {
  readonly id: Generated<string>;
  readonly organization_id: string;
  readonly name: string;
  readonly slug: string;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

/** A human principal. Global across tenants; membership links users to tenants. */
export interface AppUserTable {
  readonly id: Generated<string>;
  readonly email: string;
  readonly display_name: string;
  /** Stub until the security ADR (SLATE-202) owns the hashing scheme. */
  readonly password_hash: string;
  readonly is_active: Generated<boolean>;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

/** A tenant-scoped role (a named bundle of permissions, e.g. "admin"). */
export interface RoleTable {
  readonly id: Generated<string>;
  readonly tenant_id: string;
  readonly name: string;
  readonly description: Generated<string>;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

/** A tenant-scoped permission key (e.g. "users.read"). */
export interface PermissionTable {
  readonly id: Generated<string>;
  readonly tenant_id: string;
  readonly key: string;
  readonly description: Generated<string>;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

/** Join table: a permission granted to a role. Composite primary key. */
export interface RolePermissionTable {
  readonly role_id: string;
  readonly permission_id: string;
  readonly granted_at: Generated<Date>;
}

/** Join table: a user inside one tenant, optionally holding a role. */
export interface TenantMembershipTable {
  readonly id: Generated<string>;
  readonly tenant_id: string;
  readonly app_user_id: string;
  readonly role_id: string | null;
  readonly created_at: Generated<Date>;
  readonly updated_at: Generated<Date>;
}

/**
 * Immutable audit trail. Every mutation in later phases writes one row before
 * its response returns (SLATE-203). `payload` is redacted on the way to the
 * logger, never trusted as secret storage.
 */
export interface AuditLogTable {
  readonly id: Generated<string>;
  readonly tenant_id: string;
  readonly actor_user_id: string | null;
  readonly action: string;
  readonly resource_type: Generated<string>;
  readonly resource_id: Generated<string>;
  readonly payload: Generated<Record<string, unknown>>;
  readonly occurred_at: Generated<Date>;
}

/** Migration ledger written by the runner in `src/runner.ts`. */
export interface SlateMigrationsTable {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: Generated<Date>;
}

/** The complete Kysely schema map for the Phase 2 core tables. */
export interface Database {
  readonly organization: OrganizationTable;
  readonly tenant: TenantTable;
  readonly app_user: AppUserTable;
  readonly role: RoleTable;
  readonly permission: PermissionTable;
  readonly role_permission: RolePermissionTable;
  readonly tenant_membership: TenantMembershipTable;
  readonly audit_log: AuditLogTable;
  readonly slate_migrations: SlateMigrationsTable;
}

/**
 * Tables that carry a `tenant_id` column and are therefore eligible for the
 * tenant-scoped query helper (`src/tenant.ts`). `organization` is the root and
 * `tenant`/`app_user` are cross-tenant on purpose - they are reached through
 * explicit, reviewable queries instead of an automatic scope.
 */
export const TENANT_OWNED_TABLES = [
  'tenant_membership',
  'role',
  'permission',
  'audit_log',
] as const;

/** Every table the scoped helper will automatically filter by `tenant_id`. */
export type TenantOwnedTable = (typeof TENANT_OWNED_TABLES)[number];
