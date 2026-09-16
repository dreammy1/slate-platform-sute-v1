# Current Status

- Current Phase: Phase 2 (Slate Core)
- Last Completed Task: Executed **SLATE-201** (tenant + organization context &
  isolation) per `docs/phase2-agent-tasks.md`, on top of SLATE-200. Created the
  `packages/tenant-context` workspace (`@slate/tenant-context`):
  `src/principal.ts` (`AuthenticatedPrincipal` — server-derived `userId`,
  session-authorized `tenantIds`, session-bound `activeTenantId`; the
  `x-tenant-id` header constant), `src/context.ts` (`resolveTenantContext()`
  — a pure resolver returning a discriminated result: **401** when
  unauthenticated or when no tenant is resolvable, **403** when the header
  names a tenant outside the session's authorized set, disagrees with the
  session's active tenant, or is malformed; **200** with a validated
  `TenantContext` otherwise — plus `assertTenantContext()` throwing
  `TenantContextError` with the HTTP status; rejection happens _before any
  query can be issued_ because the resolver never touches the database),
  `src/database.ts` (`createRequestDatabase()` — per-request root client with
  `search_path` pinned to one validated schema and `tenantId`/`requestId`
  bound to the query logger; `tenantDatabaseFor(db, context)` — injects the
  resolved tenant into `createTenantDatabase` from `@slate/database`),
  `src/organization.ts` (`resolveTenantOrganization()` — tenant ⨝
  organization lookup for the owning organization row; a tenant without one
  fails loudly), and `src/events.ts` (`emitTenantSelected()` — emits
  `tenant.selected` with `{ tenantId, organizationId }` at `info` through the
  `@slate/observability` logger, so the redaction layer applies). A small
  `@slate/database` addition: `isValidTenantId()` exported for non-throwing
  callers. Tests: 19 unit (hermetic 401/403 matrix incl. the Section 65
  adversarial case, scoped-query compilation via Kysely's DummyDriver,
  event-record assertions) + 8 integration in an isolated schema via
  `@slate/testing/postgres`: tenant A's rows are invisible to tenant B's
  scope; a foreign `X-Tenant-Id` is rejected with 403 at the context layer
  with the query-log record count unchanged (proof no query was issued);
  owning-organization resolution (including the missing-row failure);
  `tenant.selected` payload verified on the captured sink; request
  `search_path` pinning with `tenantId`/`requestId` on every query record.
  Repo-wide: 170 unit + 19 integration tests green.
- Next Task: Execute **SLATE-202** (user + role + permission model &
  authorization, `agent:backend` + `agent:security`): the permission
  evaluator returning the permission set for a user in a tenant (incl.
  object-ownership lookups), the `authn`/`authz` contract API routes consult,
  and the security ADR for password hashing specifics. Gate in-flight:
  **Organization → User → Permission**. Do not begin SLATE-203 until
  SLATE-202 is green.
- Validation: `npm run verify` passes end to end — `format:check` (Prettier
  clean incl. the new package), `lint` (0 errors), `typecheck` (0 errors),
  `test:unit` (170 passed: 48 `@slate/database` + 80 `@slate/observability` +
  19 `@slate/tenant-context` + 23 `@slate/testing`), `test:integration` (19
  passed against the live `slate-postgres` container via `TEST_DATABASE_URL`:
  6 `@slate/database` + 8 `@slate/tenant-context` + 5 `@slate/testing`),
  `build` (0 errors).
- Blockers: None. Commits are local on `main` (ahead of `origin/main`); not
  yet pushed, so the first green CI run on GitHub following the
  dependabot/lockfile fix is pending.
