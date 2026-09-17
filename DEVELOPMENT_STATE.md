# Current Status

- Current Phase: Phase 2 (Slate Core)
- Last Completed Task: Executed **SLATE-203** (tenant-aware API scaffold, audit
  logging & event bus, `agent:backend` + `agent:qa`) per
  `docs/phase2-agent-tasks.md`, on top of SLATE-200/201/202. Created the
  `packages/api` workspace (`@slate/api`): `src/api.ts` (the handler chain —
  resolves the tenant context **before** opening a transaction so a rejected
  request cannot have leaked a query, re-checks the server-derived principal,
  runs every authorization and data access through SLATE-202's `createAuth` and
  SLATE-200's `db(tenantId)` inside **one** `db.transaction()`, writes exactly
  one `audit_log` row per mutation in that same transaction, and returns an
  explicit `{ status, body }` response contract), `src/events.ts` (in-process
  `createEventBus` — await-ordered best-effort delivery that never lets a
  subscriber failure turn a committed write into an HTTP error, plus
  `unsubscribe`; documented as _not_ a durable outbox), `src/http.ts` (Node
  `http` adapter: takes the principal only from an injected `authenticate`
  callback, refuses duplicate `X-Tenant-Id` headers, accepts JSON-only POST
  bodies capped at 16 KiB, sets `nosniff`/`no-store`, and is a pure factory
  that opens no listener for the caller) and `openapi.json` (the committed
  stub contract for `GET`/`POST /users`, exported as `@slate/api/openapi`, so
  later phases can contract-test). Tests: 5 unit (the pre-query 401/403 matrix
  proves `db.transaction` is never even called; the event bus awaits
  subscribers, isolates a throwing subscriber and honours unsubscribe) +
  5 integration in an isolated schema via `@slate/testing/postgres`: the
  created user + exactly one membership + exactly one tenant/user-attributed
  audit row, tenant-scoped reads that never expose another tenant's member,
  a 403 denial with no write and no publish, **rollback** of the user and
  membership when the mandatory audit insert fails, and a real Node HTTP
  round trip (POST 201 → audit → both events delivered after commit, GET 200,
  anonymous 401). Established:
  **Organization → User → Permission → Tenant record → API → Audit → Tests**
  is exercised green end to end in an isolated schema.
- Next Task: Phase 2 is **not** complete. Master Plan Section 31 still lists
  `repositories`, `services`, `settings`, `notifications`, `media`, feature
  flags and the gate's `UI` step as Phase 2 scope, and the Section 31 gate
  only closes on the real UI integration (Phase 4). Ordered follow-ups after
  this backend milestone: (1) the SLATE-204+ backlog in
  `docs/phase2-agent-tasks.md` (`audit` surface, `settings`, `notifications`,
  `media`, `jobs`, `feature flags`, `search abstraction`, `health checks`),
  each gated behind its own ADR, then (2) Phase 3
  (authentication/tenancy/RBAC flows). The `X-Tenant-Id`-header-only route
  shape and the `:tenantSlug` route variant named in the SLATE-203 API
  contract are also still unimplemented.
- Validation: `npm run verify` passes end to end — `format:check` (Prettier
  clean incl. the new package and `openapi.json`), `lint` (0 errors),
  `typecheck` (0 errors), `test:unit` (194 passed: 5 `@slate/api` +
  19 `@slate/auth` + 48 `@slate/database` + 80 `@slate/observability` +
  19 `@slate/tenant-context` + 23 `@slate/testing`), `test:integration`
  (29 passed against the live `slate-postgres` container via
  `TEST_DATABASE_URL`: 5 `@slate/api` + 5 `@slate/auth` + 6 `@slate/database`
  - 8 `@slate/tenant-context` + 5 `@slate/testing`), `build` (exit 0).
    `package-lock.json` changed only additively (22 insertions) to link the new
    workspace.
- Blockers: None. Commits are local on `main` (ahead of `origin/main`); not
  yet pushed, so the first green CI run on GitHub following the
  dependabot/lockfile fix is still pending. `packages/api/` is still untracked
  until committed.
