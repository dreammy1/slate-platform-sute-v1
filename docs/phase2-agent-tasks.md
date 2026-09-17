# Phase 2 — Slate Core: Agent Task Contracts

Master Plan references: Section 10 (Agent Task Contract), Section 15 (Slate
Core capabilities), Section 13 (never trust client-provided IDs) and Section 31
(Phase 2).

Phase 2 builds **Slate Core**. The phase gate (Section 31) requires the chain
**Organization → User → Permission → Tenant record → API → Audit → Tests**
to hold before the phase is considered complete.

The capabilities listed in Section 15 are sliced below into Agent Task
Contracts. Each row is one agent task: an owning agent role, an issue id for
branch/commit linkage, an explicit scope, what is _out_ of scope (so an agent
never widens its own boundary — Section 7), the files/packages allowed to
change, the API/database/event contracts it owns or must preserve, its
security requirements and its acceptance criteria. Contracts it depends on
appear earlier in the list; each task must not begin until its dependencies are
green (Section 2: one phase finishes before the next starts).

Architecture reference: [`docs/adr/001-database-query-toolkit.md`](adr/001-database-query-toolkit.md)
selects **Kysely on `pg`** as the database abstraction. Every downstream task
assumes that decision. [`docs/adr/003-system-settings-and-feature-flags.md`](adr/003-system-settings-and-feature-flags.md)
(Accepted) governs SLATE-204. [ADR 004](adr/004-background-jobs-and-task-queue.md)
(Proposed) gates SLATE-205 and must be accepted before implementation
(Section 67).

> Issue IDs use the `SLATE-200` series for Phase 2. They are placeholders for
> the real GitHub issues created from this plan; branch names follow
> `SLATE-200-<slug>` (Section 7).

## Task index

| Issue     | Agent                          | Capability                                                            | Gate link                              |
| --------- | ------------------------------ | --------------------------------------------------------------------- | -------------------------------------- |
| SLATE-200 | agent:backend                  | database abstraction (Kysely, `pg`, migrations, tenant-scoped helper) | Tenant record                          |
| SLATE-201 | agent:backend                  | tenant + organization context & isolation                             | Organization → Tenant record           |
| SLATE-202 | agent:backend + agent:security | user + role + permission model & authz                                | User → Permission                      |
| SLATE-203 | agent:backend + agent:qa       | tenant-aware API scaffold, audit logging, event bus                   | API → Audit → Tests                    |
| SLATE-204 | agent:backend + agent:security | system settings & feature flags                                       | Configuration → Isolation → Audit      |
| SLATE-205 | agent:backend + agent:security | background jobs & task queue                                          | Enqueue → Isolation → Recovery → Audit |

---

## SLATE-200 — Database abstraction

- **Owning agent:** `agent:backend`
- **Milestone:** M2 Core
- **Scope:** Stand up the shared database layer consumed by every Phase 2 task.
- **Out of scope:** no ORM; no relations graph; no auto-generated CRUD resolvers;
  no migrations beyond the Phase 2 core tables; no `packages/api` yet.
- **Allowed files/packages:**
  - `packages/database/` (new)
  - `packages/observability/src/` (only if a redaction export is missing; otherwise reuse)
  - `infrastructure/postgres/init/` (read-only, to mirror bootstrap conventions)
  - `docs/adr/001-database-query-toolkit.md` (read)
  - root `package.json` / `package-lock.json` (only for the `@types/pg`/`kysely`/`pg` addition)
- **Contracts:**
  - Database contract (migration required: yes): the Phase 2 tables
    (`organization`, `tenant`, `tenant_membership`, `app_user`, `role`,
    `permission`, `role_permission`, `audit_log`) — final DDL in
    `packages/database/src/migrations/`.
  - API contract: the `db(tenantId)` helper signature exposed to SLATE-201.
  - Logging contract: `onQuery` entries emitted at `debug` through the
    `@slate/observability` logger; bound parameters never logged in plaintext.
- **Security requirements:**
  - `pg` connection uses `ssl` in staging/preview (Section 61: no secrets in logs).
  - `DATABASE_URL` parsed and validated; a malformed URL throws at startup
    (mirrors `env.ts` throwing-on-invalid, never fallback).
- **Acceptance criteria:**
  - A clean clone installs with `npm ci` and the new `kysely`/`pg` deps resolve.
  - `npm run verify` is green with the new workspace added.
  - A smoke test using `@slate/testing/postgres`'s `createIsolatedDatabase` runs a
    Kysely query against `TEST_DATABASE_URL` in its own schema and asserts the
    tenant-scoped helper rejects a query whose `tenantId` does not match the
    request scope.
  - `onQuery` log lines are emitted at `debug` and never contain a secret value.

---

## SLATE-201 — Tenant + organization context & isolation

- **Owning agent:** `agent:backend`
- **Milestone:** M2 Core
- **Dependencies:** SLATE-200 (`packages/database`)
- **Scope:** Request-scoped tenant context. Resolve the tenant from the
  authenticated principal or an `X-Tenant-Id` header (never trusted from the
  client alone — Section 13), and inject it into the `db(tenantId)` helper from
  SLATE-200. Add `search_path` scoping per request and the `organization` row
  that owns the tenant. Tests assert a tenant cannot read another tenant's rows.
- **Out of scope:** authentication itself (SLATE-202); users, roles, permissions;
- **Contracts:**
  - Database contract: adds `tenant` + `organization` + `tenant_membership`
    inserts to the SLATE-200 migrations; no column may be nullable where the
    tenant id is required.
  - Event contract: emits `tenant.selected` with `{ tenantId, organizationId }`.
- **Security requirements:**
  - Section 13: tenant/organization IDs come from the session, never from a
    client header alone.
  - Section 65 adversarial cases: a request carrying `X-Tenant-Id` of another
    tenant must be rejected at the context layer, not silently served.
- **Acceptance criteria:**
  - Given a request for tenant A, when a row is inserted for tenant A via
    `db(A)`, then the same query against tenant B's scope returns no rows.
  - Given a request that presents `X-Tenant-Id = B` while authenticated to
    tenant A, then the context layer rejects it (403) and no query is issued.
  - Integration test runs in an isolated schema via `@slate/testing/postgres`.

---

## SLATE-202 — User + role + permission model & authorization

- **Owning agent:** `agent:backend` + `agent:security` (co-owners)
- **Milestone:** M2 Core
- **Dependencies:** SLATE-201 (tenant context)
- **Scope:** Authentication anchor + the authorization spine: `app_user`,
  `role`, `permission`, `role_permission` tables (extend SLATE-200 migration); a
  permission evaluator that returns the set of permissions for a user in a
  tenant, including object-ownership lookups; the `authn`/`authz` contract every
  API route consults. Gate in-flight: **Organization → User → Permission**.
- **Out of scope:** external identity providers, OAuth flows, RBAC UI, feature
  flags (SLATE-204), password hashing specifics (stubbed; real crypto is a
  security ADR).
- **Allowed files/packages:** `packages/database/`, `packages/auth/` (new),
  `packages/testing/` (integration only), `docs/adr/` (auth ADRs).
- **Contracts:**
  - Database contract: `app_user`, `role`, `permission`, `role_permission`,
    and a join to `tenant` (a permission is only valid in its tenant).
  - API contract: `getCurrentUser(): Promise<AppUser | null>` and
    `hasPermission(user, tenantId, permission): Promise<boolean>`.
- **Security requirements:**
  - Section 13: user/tenant/permission IDs are server-derived.
  - Section 65: adversarial case — a user whose role is revoked mid-session must
    not gain access to resources they held via the stale grant.
- **Acceptance criteria:**
  - A tenant's users cannot see another tenant's permissions in their set.
  - Revoking a role's permission removes it from `hasPermission` immediately.
  - Unit suite covers the evaluator; integration suite runs in an isolated
    schema.

---

## SLATE-203 — Tenant-aware API scaffold, audit logging & event bus

- **Owning agent:** `agent:backend` + `agent:qa` (co-owners)
- **Milestone:** M2 Core
- **Dependencies:** SLATE-200, SLATE-201, SLATE-202
- **Scope:** The HTTP API scaffold that wires the tenant context (SLATE-201) and
  the authz (SLATE-202) together: a request handler that resolves the tenant,
  evaluates permissions, runs a Kysely query via `db(tenantId)`, emits an
  `audit_log` write per mutation, and publishes domain events onto the
  in-process event bus. Gate in-flight: **API → Audit → Tests**. Observability
  baseline (`@slate/observability`) is already wired from SLATE-200's `onQuery`.
- **Out of scope:** production HTTP framework choice (Node `http` is fine for
  the scaffold); UI (Phase 4); external event transport (in-process only this phase).
- **Allowed files/packages:** `packages/api/` (new), `packages/database/`,
  `packages/auth/`, `packages/observability/`, `packages/testing/` (test only),
  `@types/node`.
- **Contracts:**
  - API contract: every route reads `GET /:tenantSlug/...` or the
    `X-Tenant-Id`-scoped context; the OpenAPI shape (stub) is committed so later
    phases can contract-test.
  - Database contract: `audit_log` schema from SLATE-200; the audit insert is
    non-optional for mutations.
  - Event contract: `eventBus.publish(name, payload)`; `app.user.created`,
    `app.audit.recorded`.
- **Security requirements:**
  - Every mutation writes an `audit_log` row before the response returns.
  - Section 61: audit payloads pass through the logger's redaction layer.
- **Acceptance criteria:**
  - A request without a valid tenant context returns 401/403 before any DB query.
  - A write that passes authorization produces exactly one `audit_log` row
    attributed to the tenant and user.
  - Unit suite for the handler chain; integration suite (isolated schema) proves
    tenant-scoped reads and the audit row in one transaction.
- **Definition of Done (Phase 2):** after SLATE-203, the Section 31 gate
  **Organization → User → Permission → Tenant record → API → Audit → Tests**
  is exercised green in an isolated schema, and `npm run verify` is clean.

## SLATE-204 — System settings & feature flags

- **Owning agent:** `agent:backend` + `agent:security` (co-owners)
- **Milestone:** M2 Core
- **Dependencies:** SLATE-200, SLATE-201, SLATE-202, SLATE-203
- **Architecture reference:** `docs/adr/003-system-settings-and-feature-flags.md`
  — must be read (Section 67) and **accepted** before implementation begins.
- **Scope:** The tenant-scoped configuration store and the server-authoritative
  flag resolver. Extend the SLATE-200 migration with two tenant-owned tables
  (`system_setting`, `feature_flag`), register both in `TENANT_OWNED_TABLES`
  and the typed schema map, and create `packages/settings` (`@slate/settings`):
  the dotted-key validator, typed value round-tripping
  (`string | number | boolean | json`), `getSetting` / `setSetting` through
  `db(tenantId)`, the code-owned flag definition registry, and
  `resolveFeatureFlag` / `resolveFeatureFlags` (`tenant override → registry
default → false` for an unknown key). Extend the SLATE-203 API with
  `GET /settings`, `PUT /settings/:key`, `GET /features`, `PUT /features/:key`
  on the existing chain (context → authz → `db(tenantId)` → audit → events),
  seed `settings.read` / `settings.write` / `features.read` / `features.write`,
  write exactly one attributed `audit_log` row per accepted write inside the
  transaction, and publish `settings.updated` / `feature.flag.updated` after
  commit. Gate in-flight: **Configuration → Isolation → Audit**. Update the
  committed OpenAPI stub.
- **Out of scope:** flag targeting rules (per-user flags, percentage rollout,
  scheduling, experiments); entitlement/licence gating (Phase 6 — Section 60
  forbids a flag becoming the entitlement check); plugin-registered settings
  (`registerSettings()`, Phase 5); settings/flag UI (Phase 4 shell); secret
  storage/KMS; caching of resolved values.
- **Allowed files/packages:** `packages/settings/` (new), `packages/database/`,
  `packages/api/`, `packages/auth/` (test seeding only), `packages/testing/`
  (test only), `docs/adr/003-*.md`, `docs/phase2-agent-tasks.md`,
  `DEVELOPMENT_STATE.md`.
- **Contracts:**
  - Database contract (migration required: yes):
    `system_setting (id, tenant_id NOT NULL, key, value_type, value jsonb,
created_at, updated_at)` and `feature_flag (id, tenant_id NOT NULL, key,
enabled boolean NOT NULL, created_at, updated_at)`, each with a unique
    `(tenant_id, key)` index and both added to `TENANT_OWNED_TABLES`; no column
    nullable where the tenant id is required. Migration + clean-install +
    upgrade coverage per Section 57.
  - API contract: `GET /settings` → `{ settings: [{ key, value, valueType }] }`;
    `PUT /settings/:key` → `{ setting }`; `GET /features` →
    `{ features: { [key]: boolean } }`; `PUT /features/:key` →
    `{ key, enabled }`. Errors keep the SLATE-203 shape and statuses
    (401/403 before any query, 400 for an invalid key/value, 500 with rollback).
    The OpenAPI stub in `packages/api/openapi.json` is updated in the same PR.
  - Event contract: `settings.updated` and `feature.flag.updated`, payload
    `{ tenantId, key, actorUserId }`, published after commit — never the value.
- **Security requirements:**
  - Section 13: the tenant comes from the resolved context; `X-Tenant-Id` alone
    is never trusted and a client cannot supply a tenant id or a trusted
    resolved flag state. Only the `features.write`-authorized PUT accepts
    `{ enabled: boolean | null }` as an override command (`null` clears it).
  - Section 60: flags are server-authoritative; an unknown key resolves to
    `false` and never throws.
  - Section 65 adversarial: tenant A cannot read or write tenant B's rows; a
    member without `settings.write` / `features.write` receives 403 with no
    write, no audit row and no event; a permission revoked mid-session is
    effective on the very next call (no caching).
  - Section 61: values pass through the logger's redaction layer; events carry
    keys, not values.
- **Acceptance criteria:**
  - Given settings written for tenant A, when tenant B calls `GET /settings`,
    then no tenant A row is visible.
  - Given a defined flag with no override, when `GET /features` is called, then
    the registry default is returned; given a never-defined key, then `false`.
  - Given a member without the matching permission, when `PUT /features/:key`
    is called, then 403 and no row, no audit and no event.
  - Given `PUT /settings/:key`, then exactly one tenant/user-attributed
    `audit_log` row commits with the write and `settings.updated` is delivered
    only after commit.
  - Integration test runs in an isolated schema via `@slate/testing/postgres`.
- **Tests required:** unit (key/value validation, typed round-trip, resolution
  order incl. the unknown-key fail-closed case, fake-based isolation of the
  query service) + integration (isolation in both directions, permission
  denial, the audit row, rollback when the mandatory audit insert fails, and a
  live permission revocation observed on the next call).
- **Definition of Done:** the four routes are green end to end in an isolated
  schema with ADR 003 accepted and `npm run verify` clean (Section 64), and no
  required Section 68 cell (API / DB / Permission / Tenant / Events / Tests /
  Docs) is left unchecked.

---

## SLATE-205 — Background jobs & task queue

- **Owning agent:** `agent:backend` + `agent:security`; `agent:qa` validates concurrency.
- **Milestone:** M2 Core.
- **Dependencies:** SLATE-200 through SLATE-204 (verified); ADR 004 acceptance.
- **Architecture reference:** [ADR 004](adr/004-background-jobs-and-task-queue.md)
  (**Proposed**). Read and accept it before implementation.
- **Scope:** Create `packages/jobs` (`@slate/jobs`) using existing Kysely/`pg`.
  Provide transactional enqueue, a typed/versioned handler registry with runtime
  validation, tenant-bound workers, bounded retries, renewable leases,
  idempotency and read-only job inspection. Jobs precede notifications and media
  so these can enqueue durable work rather than rely on event subscribers.
  Gate: **Enqueue → Isolation → Recovery → Audit**.
- **Out of scope:** notification transports/templates, media handlers, arbitrary
  HTTP job submission, retry/cancel endpoints, UI, cron, workflows, priorities,
  cross-tenant dispatch, retention/purge, deployment orchestration, brokers and
  exactly-once delivery. No timers on package import.
- **Allowed files/packages:** `packages/jobs/` (new), `packages/database/`
  (migration/schema and opt-in queue parameter omission), `packages/api/`
  (inspection routes, event bridge, OpenAPI, tests), `packages/testing/`
  (test-only helpers), root `package-lock.json` (workspace linkage),
  `docs/adr/004-background-jobs-and-task-queue.md`, this contract and
  `DEVELOPMENT_STATE.md`. Reuse observability; add no queue library or service.
- **Contracts:**
  - Database (migration required: yes): `0006_background_jobs.sql` adds
    `background_job` with `id`, mandatory `tenant_id`, `type`, `payload jsonb`,
    `idempotency_key`, constrained `status`, `attempts`, `max_attempts`,
    `available_at`, `lease_token`, `lease_expires_at`, `actor_user_id`,
    `request_id`, `last_error_code`, `finished_at`, `created_at`, `updated_at`.
    Nullability, foreign keys, state constraints and indexes follow ADR 004.
    Register in `Database` and `TENANT_OWNED_TABLES`; unique
    `(tenant_id, type, idempotency_key)` prevents duplicate submissions.
  - Package API: registry definitions pair a versioned dotted key with
    `parse(unknown)` and a typed async handler. `enqueue(trx, context, input)`
    requires a transaction and returns `{ jobId, created, notification }`
    (notification absent on duplicates). One new job and one `jobs.enqueued`
    audit row share the domain transaction. Different payloads for an existing
    key conflict; identical duplicates reuse the row without another audit/event.
    `createWorker({ tenantId, registry, db, logger, ... })` exposes explicit
    start/stop and a testable runOnce. Handlers receive scoped DB access and an
    abort signal. Expose `getQueueStats(tenantId)`.
  - Worker: short atomic `FOR UPDATE SKIP LOCKED` claim, handler outside the
    transaction, fenced acknowledgement/renewal/failure. Match tenant, job id,
    running state, unexpired lease and token on transitions. Attempts increment
    on claim. Retry transient failures with bounded exponential backoff/jitter;
    recover expired leases, including terminal failure of exhausted attempts.
    Defaults and limits follow ADR 004. Timeout/shutdown are cooperative and
    do not guarantee exactly-once external side effects.
  - HTTP: `GET /jobs` → `{ jobs: JobSummary[], nextCursor: string | null }`;
    `GET /jobs/:id` → `{ job: JobSummary }`. Summary allowlist: id, type, status,
    attempts, maxAttempts, availableAt, createdAt, updatedAt, finishedAt,
    lastErrorCode. List accepts limit (1–100, default 50), status and opaque
    `(created_at, id)` cursor, ordered ascending on that pair. Validate query
    parameters independently of path routing; cursors never choose a tenant.
    Both routes require `jobs.read`; preserve `{ error }` with 400 invalid input,
    401 absent identity/context, 403 denied permission/context, 404 missing or
    foreign job, and 500 unexpected failure. Update OpenAPI. Never return payload,
    lease token, idempotency key or raw error details.
  - Events: `jobs.enqueued`, `jobs.succeeded`, `jobs.failed`,
    `jobs.retry_scheduled` carry `{ tenantId, jobId, type, attempt }` only.
    Publish after commit through an injected interface bridged by the host to
    the existing bus; never create durable work from a post-commit callback.
    Duplicate enqueue emits nothing; publisher failures do not undo state.
  - Observability: request/tenant/job-bound child loggers, safe failure codes,
    attempt duration and queue statistics (due/delayed/running/failed counts,
    oldest due age). Typed observer callbacks need no metrics vendor. Payload
    omission includes SQL query/error logging; test the opt-in omission mode
    without changing unrelated logging defaults.

- **Security requirements:** only trusted server code registers/enqueues job types.
  Runtime validation enforces bounded JSON (16 KiB serialized payload maximum).
  Context supplies tenant/actor/request ids, never payload fields. Workers are
  assigned one tenant by the host; handlers receive no root database client.
  Reload references tenant-scoped and reauthorize deferred user-privileged work;
  recorded actor ids are attribution, not a permission grant. Seed `jobs.read`
  in fixtures using SLATE-202 patterns; document production grants without
  auto-granting access. API checks use live permissions and hide foreign ids.
  Audit, events, SQL logs and errors must not expose payloads or exception text.
- **Acceptance criteria:**
  - Domain write, enqueue and audit commit together; audit failure rolls all
    three back and emits no event. Another connection sees no uncommitted job.
  - Same tenant/type/key deduplicates; changed payload conflicts. The same key
    in tenant B is independent. A cannot inspect, claim or acknowledge B's job.
  - Independent workers cannot claim the same live lease. Expiry allows crash
    recovery, but a stale worker cannot acknowledge or renew the replacement lease.
  - Success is terminal. Transient failures schedule retries; exhaustion and
    permanent failures become terminal, including an expired final attempt.
    Unknown types/invalid stored payloads invoke no handler. Shutdown, timeout
    and lease loss exercise cooperative cancellation and bounded concurrency.
  - Read routes require `jobs.read`; revocation takes effect on the next call.
    Pagination remains tenant-scoped and foreign job ids return 404.
  - Events observe committed rows; logger/observer failures leave state intact.
    Payload sentinels never appear in SQL logs, errors, audit, events or API.
- **Tests required:** unit tests for registry typing (including compile-time
  invalid-input cases), validation, retry bounds, transitions and shutdown;
  isolated PostgreSQL integration tests for clean install/0005 upgrade/rerun,
  concurrent claims on independent connections, rollback, deduplication, tenant
  isolation, fencing and recovery. Inject time/random sources in unit tests and
  control persisted lease timestamps in integration tests, rather than relying
  on sleeps. Exercise both read routes through the Node HTTP adapter and a
  test-only idempotent handler, without adding a production domain capability.
- **Definition of Done:** ADR 004 accepted; all criteria above tested;
  `npm run verify` clean; API/DB/Permission/Tenant/Events/Tests/Docs covered
  (UI explicitly deferred). Update development state without declaring the
  remaining Phase 2 backlog complete.

---

## Planning artifact map

| Phase 2 capability (Section 15)                                          | First task                     |
| ------------------------------------------------------------------------ | ------------------------------ |
| `database abstraction`                                                   | SLATE-200 (Kysely — ADR 001)   |
| `tenants`, `organizations`                                               | SLATE-201                      |
| `users`, `roles`, `permissions`                                          | SLATE-202                      |
| `API`, event bus                                                         | SLATE-203                      |
| `jobs`                                                                   | SLATE-205 (ADR 004 — Proposed) |
| `audit`, `notifications`, `media`, `search abstraction`, `health checks` | SLATE-206+ (post-ADR backlog)  |
| `settings`, `feature flags`                                              | SLATE-204 (ADR 003)            |

> `authentication` is intentionally owned by SLATE-202 (authn is the prerequisite
> to authorizing a user); `plugin runtime`, `license verification`, `theme
runtime` etc. begin in their own phases (Section 73 ordering).

the HTTP API (SLATE-203).

- **Allowed files/packages:** `packages/database/`, `packages/tenant-context/` (new),
  `packages/testing/` (test only).
  Create `packages/database`: a `Kysely<Database>` connection factory that reads
  `DATABASE_URL` (and `DIRECT_URL` for migrations), the typed schema interfaces
  for the Phase 2 tables, hand-written raw SQL migrations executed by a minimal
  runner, and the **tenant-scoped query helper** (see SLATE-201) that threads
  `tenantId` through every query so isolation is a call-site property, not a
  convention. Wire `onQuery` logging into `@slate/observability` so each query
  is recorded on a request-id-bound child logger with parameters run through
  `redactValue` + `scrubSecrets`.
- **Out of scope:** no ORM; no relations graph; no auto-generated CRUD resolvers;
  no migrations beyond the Phase 2 core tables; no `packages/api` yet.
