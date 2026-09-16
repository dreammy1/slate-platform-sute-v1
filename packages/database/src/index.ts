/**
 * `@slate/database` - the Phase 2 database abstraction (Kysely on `pg`).
 *
 * Four concerns, in the order an application needs them:
 *
 * 1. **Typed schema** ({@link Database}, one interface per core table).
 * 2. **Connection** ({@link createDatabase}) - `DATABASE_URL`/`DIRECT_URL`
 *    validated at startup, TLS outside local environments, `onQuery` logging
 *    through `@slate/observability` with redacted parameters.
 * 3. **Migrations** ({@link runMigrations}) - raw `.sql` files in
 *    `src/migrations/`, ledger + checksums, applied over `DIRECT_URL`.
 * 4. **Tenant scoping** ({@link createTenantDatabase}) - the `db(tenantId)`
 *    helper that makes isolation a call-site property.
 *
 * Every module is also importable on its own (`@slate/database/client`, ...)
 * so a consumer that only needs the types does not pull in the driver.
 *
 * docs/adr/001-database-query-toolkit.md (Decision), Master Plan Section 15
 * (`database abstraction`), Section 61 (observability), Section 79 (controlled
 * execution, tenant isolation).
 */

export * from './client.ts';
export * from './env.ts';
export * from './runner.ts';
export * from './tenant.ts';
export * from './types.ts';
export * from './migrations/index.ts';
