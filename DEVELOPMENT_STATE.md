# Current Status

- Current Phase: Phase 2 (Slate Core)
- Last Completed Task: Executed **SLATE-200** (database abstraction) per
  `docs/phase2-agent-tasks.md` and `docs/adr/001-database-query-toolkit.md`.
  Created the `packages/database` workspace (`@slate/database`) with `kysely`
  - `pg` (runtime) and `@types/pg` (types) — `@slate/observability` moved from
    dev to runtime dependencies because the query logger consumes it. Shipped:
    `src/env.ts` (`DATABASE_URL`/`DIRECT_URL` readers that validate the URL and
    throw at startup on anything malformed, echoing only `scrubSecrets`-sanitized
    values), `src/types.ts` (typed column interfaces + the `Kysely` `Database`
    map for the 8 Phase 2 tables plus the `slate_migrations` ledger),
    `src/client.ts` (`createDatabase()` factory on a `pg` Pool: TLS outside
    local environments — staging/preview/production, optional `searchPath`
    scoping, and the `onQuery` listener via Kysely 0.29's `log(event)` surface
    emitting at `debug` through `@slate/observability` with every bound parameter
    run through `redactValue`+`scrubSecrets` so no plaintext secret reaches the
    sink), `src/migrations/` (4 raw, dependency-ordered `.sql` files —
    `0001_organization_and_tenant`, `0002_app_user`, `0003_roles_and_permissions`,
    `0004_tenant_membership_and_audit_log` — split on
    `--> statement-breakpoint` lines) with a loader and `src/runner.ts`
    (`runMigrations` ledger + sha256 checksum drift detection,
    `runMigrationsFromEnv` over `DIRECT_URL`), and `src/tenant.ts`
    (`createTenantDatabase(db, tenantId)`: UUID-validated scope, forced
    `where tenant_id =` on selects/updates/deletes, `tenant_id` injection on
    inserts with foreign-id rejection via `TenantScopeError`; scope covers only
    `TenantOwnedTable`s — `tenant_membership`, `role`, `permission`,
    `audit_log`). Tests: 48 unit (hermetic — env parsing, redacted query
    logging against an injected sink, tenant scoping compiled against Kysely's
    DummyDriver, migration file integrity) + 6 integration against the live
    `slate-postgres` container via `@slate/testing/postgres`
    `createIsolatedDatabase` (migration execution + ledger idempotency, table
    presence, tenant A/B isolation, foreign-tenant rejection, secret-free debug
    query logs). Repo-wide: 151 unit + 11 integration tests green. Housekeeping:
    `*.sql` added to `.prettierignore` (no Prettier SQL parser), package
    lockfile resynced for the dependency move.
- Next Task: Execute **SLATE-201** (tenant + organization context &
  isolation, `agent:backend`): resolve the tenant from the authenticated
  principal or an `X-Tenant-Id` header (never from the client alone),
  inject it into `createTenantDatabase(db, tenantId)` from SLATE-200, add
  `search_path`-per-request scoping and the `organization` row that owns the
  tenant, and emit `tenant.selected` with `{ tenantId, organizationId }`.
  Tests must prove tenant A cannot read tenant B's rows and that a foreign
  `X-Tenant-Id` is rejected at the context layer (403) before any query.
- Validation: `npm run verify` passes end to end — `format:check` (Prettier
  clean incl. the new package), `lint` (0 errors), `typecheck` (0 errors),
  `test:unit` (151 passed: 48 `@slate/database` + 80 `@slate/observability` +
  23 `@slate/testing`), `test:integration` (11 passed against the live
  `slate-postgres` container via `TEST_DATABASE_URL`: 6 `@slate/database` +
  5 `@slate/testing`), `build` (0 errors).
- Blockers: None. Commits are local on `main` (ahead of `origin/main`); not
  yet pushed, so the first green CI run on GitHub following the
  dependabot/lockfile fix is pending.
