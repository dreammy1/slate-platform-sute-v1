/**
 * The tenant-scoped query helper: `db(tenantId)`.
 *
 * Isolation here is a call-site property, not a convention (Master Plan
 * Sections 13 and 79): a tenant id is validated up front, selects are filtered
 * with a forced `where tenant_id = $1`, inserts inject the scope's `tenant_id`
 * (rejecting a foreign one), and updates/deletes are confined to the scope
 * even when the caller forgets its own predicate. A query that would cross
 * tenant boundaries is therefore not expressible by accident - and a bypass
 * (`src/client.ts` unscoped access) stays visible at the call site.
 *
 * Only tables carrying a `tenant_id` column ({@link TenantOwnedTable}) are
 * reachable through the helper; `organization`, `tenant` and `app_user` are
 * cross-tenant by design and stay on explicit root queries.
 *
 * docs/adr/001-database-query-toolkit.md (Decision),
 * docs/phase2-agent-tasks.md (SLATE-200 API contract).
 */

import type {
  DeleteQueryBuilder,
  DeleteResult,
  InsertObject,
  InsertQueryBuilder,
  InsertResult,
  Kysely,
  Selectable,
  SelectQueryBuilder,
  UpdateQueryBuilder,
  UpdateResult,
} from 'kysely';

import type { Database, TenantOwnedTable } from './types.ts';

const ERROR_PREFIX = '[slate/database]';

/** Thrown when a query would cross the tenant boundary or use an invalid scope. */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(`${ERROR_PREFIX} ${message}`);
    this.name = 'TenantScopeError';
  }
}

/** Tenant ids are UUIDs; anything else is rejected before a query is built. */
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Non-throwing tenant-id check for callers that need a result instead of an
 * exception (the context resolver maps an invalid id to a 403, for example).
 */
export function isValidTenantId(tenantId: string): boolean {
  return TENANT_ID_PATTERN.test(tenantId.trim());
}

/**
 * Validates a tenant id. Kept strict on purpose: the id ends up inside a SQL
 * predicate on every scoped query, so only the canonical shape may pass.
 *
 * @throws {@link TenantScopeError} for an empty, malformed or over-long id.
 */
export function assertTenantId(tenantId: string): string {
  const candidate = tenantId.trim();
  if (!isValidTenantId(candidate)) {
    throw new TenantScopeError(
      `"${candidate.slice(0, 64)}" is not a valid tenant id: expected a UUID.`,
    );
  }
  return candidate;
}

/**
 * Insert values for a tenant-owned table, *without* `tenant_id`: the helper
 * injects the scope's id, and an explicit foreign one is rejected at runtime.
 */
export type TenantInsertObject<K extends TenantOwnedTable> = Omit<
  InsertObject<Database, K>,
  'tenant_id'
>;

/** The tenant-scoped view of the database handed to application code. */
export interface TenantScopedDatabase {
  /** The validated tenant every query in this scope is confined to. */
  readonly tenantId: string;
  /** Pre-filtered select: rows outside the scope are invisible. */
  selectFrom<K extends TenantOwnedTable>(
    table: K,
  ): SelectQueryBuilder<Database, K, Selectable<Database[K]>>;
  /** Insert with the scope's `tenant_id` injected and foreign ids rejected. */
  insertInto<K extends TenantOwnedTable>(
    table: K,
    values: TenantInsertObject<K>,
  ): InsertQueryBuilder<Database, K, InsertResult>;
  /** Update confined to the scope, whatever the caller's own `where` says. */
  updateTable<K extends TenantOwnedTable>(
    table: K,
  ): UpdateQueryBuilder<Database, K, K, UpdateResult>;
  /** Delete confined to the scope, whatever the caller's own `where` says. */
  deleteFrom<K extends TenantOwnedTable>(table: K): DeleteQueryBuilder<Database, K, DeleteResult>;
}

/**
 * Creates a tenant-scoped query helper around a root client.
 *
 * @example
 * ```ts
 * const tenantDb = createTenantDatabase(db, tenantId);
 * const rows = await tenantDb.selectFrom('audit_log').selectAll().execute();
 * ```
 *
 * @throws {@link TenantScopeError} when `tenantId` is not a UUID.
 */
export function createTenantDatabase(db: Kysely<Database>, tenantId: string): TenantScopedDatabase {
  const scopedTenantId = assertTenantId(tenantId);

  function guardForeignTenant(values: TenantInsertObject<TenantOwnedTable>): void {
    const requested = (values as Record<string, unknown>)['tenant_id'];
    if (requested !== undefined && requested !== scopedTenantId) {
      throw new TenantScopeError(
        `insert carries tenant_id "${String(requested).slice(0, 64)}" but the request scope is ` +
          `"${scopedTenantId}". A row cannot be written across the tenant boundary.`,
      );
    }
  }

  function selectFrom<K extends TenantOwnedTable>(
    table: K,
  ): SelectQueryBuilder<Database, K, Selectable<Database[K]>> {
    // The forced predicate is applied once, here: a scoped select cannot be
    // built without it. The intermediate union type lets TypeScript verify
    // that `tenant_id` is a column of every scoped table.
    const builder = db.selectFrom(table) as unknown as SelectQueryBuilder<
      Database,
      TenantOwnedTable,
      Selectable<Database[TenantOwnedTable]>
    >;
    return builder.where('tenant_id', '=', scopedTenantId) as unknown as SelectQueryBuilder<
      Database,
      K,
      Selectable<Database[K]>
    >;
  }

  function insertInto<K extends TenantOwnedTable>(
    table: K,
    values: TenantInsertObject<K>,
  ): InsertQueryBuilder<Database, K, InsertResult> {
    guardForeignTenant(values);
    const scoped = { ...values, tenant_id: scopedTenantId } as unknown as InsertObject<Database, K>;
    return db.insertInto(table).values(scoped);
  }

  function updateTable<K extends TenantOwnedTable>(
    table: K,
  ): UpdateQueryBuilder<Database, K, K, UpdateResult> {
    const builder = db.updateTable(table) as unknown as UpdateQueryBuilder<
      Database,
      TenantOwnedTable,
      TenantOwnedTable,
      UpdateResult
    >;
    return builder.where('tenant_id', '=', scopedTenantId) as unknown as UpdateQueryBuilder<
      Database,
      K,
      K,
      UpdateResult
    >;
  }

  function deleteFrom<K extends TenantOwnedTable>(
    table: K,
  ): DeleteQueryBuilder<Database, K, DeleteResult> {
    const builder = db.deleteFrom(table) as unknown as DeleteQueryBuilder<
      Database,
      TenantOwnedTable,
      DeleteResult
    >;
    return builder.where('tenant_id', '=', scopedTenantId) as unknown as DeleteQueryBuilder<
      Database,
      K,
      DeleteResult
    >;
  }

  return {
    tenantId: scopedTenantId,
    selectFrom,
    insertInto,
    updateTable,
    deleteFrom,
  };
}
