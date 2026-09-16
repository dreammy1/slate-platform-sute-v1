/**
 * Request-scoped database clients.
 *
 * Two pieces glue the resolved {@link TenantContext} into the SLATE-200
 * database abstraction:
 *
 * - **`createRequestDatabase`** builds the per-request root client with the
 *   `search_path` pinned to one schema (unqualified identifiers can only
 *   resolve inside it) and with `tenantId`/`requestId` bound to the query
 *   logger, so every query record of the request is attributable.
 * - **`tenantDatabaseFor`** injects the resolved tenant id into
 *   `createTenantDatabase(db, tenantId)` from `@slate/database`: the scoped
 *   helper forces `where tenant_id =` on selects/updates/deletes and injects
 *   it on inserts. Application code never sees an unscoped table.
 */

import type { Kysely } from 'kysely';

import type { LogContext } from '@slate/observability';

import {
  createDatabase,
  createTenantDatabase,
  type CreateDatabaseOptions,
  type Database,
  type TenantScopedDatabase,
} from '@slate/database';

import type { TenantContext } from './context.ts';

const ERROR_PREFIX = '[slate/tenant-context]';

/** Options accepted by {@link createRequestDatabase}. */
export interface CreateRequestDatabaseOptions extends Omit<
  CreateDatabaseOptions,
  'searchPath' | 'logBindings'
> {
  /**
   * Schema the request's unqualified queries are pinned to (per-request
   * `search_path` scoping, SLATE-201). Validated by `@slate/database`.
   */
  readonly schema: string;
  /** The resolved tenant context; its id is bound to every query log record. */
  readonly context: TenantContext;
  /** Request correlation id, bound to every query log record. */
  readonly requestId?: string | undefined;
  /** Extra fields bound to every query log record, next to tenantId/requestId. */
  readonly logBindings?: LogContext | undefined;
}

/**
 * Builds the per-request root client: `search_path` pinned to `schema`,
 * `tenantId` (and `requestId`, when present) bound to the query logger.
 *
 * @throws when the connection string or `schema` is invalid.
 */
export function createRequestDatabase(options: CreateRequestDatabaseOptions): Kysely<Database> {
  const { schema, context, requestId, logBindings, ...rest } = options;
  return createDatabase({
    ...rest,
    searchPath: schema,
    logBindings: {
      ...logBindings,
      tenantId: context.tenantId,
      ...(requestId === undefined ? {} : { requestId }),
    },
  });
}

/**
 * Injects the resolved tenant into the SLATE-200 scoped query helper.
 *
 * @example
 * ```ts
 * const context = assertTenantContext({ principal, requestedTenantId });
 * const tenantDb = tenantDatabaseFor(db, context);
 * await tenantDb.selectFrom('audit_log').selectAll().execute();
 * ```
 *
 * @throws {@link TenantScopeError} when the context tenant id is invalid.
 */
export function tenantDatabaseFor(
  db: Kysely<Database>,
  context: TenantContext,
): TenantScopedDatabase {
  if (context.tenantId.trim() === '') {
    throw new Error(`${ERROR_PREFIX} the tenant context carries no tenant id.`);
  }
  return createTenantDatabase(db, context.tenantId);
}
