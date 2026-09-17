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
(Proposed) gates SLATE-204 and must be accepted before that task starts
(Section 67).

> Issue IDs use the `SLATE-200` series for Phase 2. They are placeholders for
> the real GitHub issues created from this plan; branch names follow
> `SLATE-200-<slug>` (Section 7).

## Task index

| Issue     | Agent                          | Capability                                                            | Gate link                         |
| --------- | ------------------------------ | --------------------------------------------------------------------- | --------------------------------- |
| SLATE-200 | agent:backend                  | database abstraction (Kysely, `pg`, migrations, tenant-scoped helper) | Tenant record                     |
| SLATE-201 | agent:backend                  | tenant + organization context & isolation                             | Organization → Tenant record      |
| SLATE-202 | agent:backend + agent:security | user + role + permission model & authz                                | User → Permission                 |
| SLATE-203 | agent:backend + agent:qa       | tenant-aware API scaffold, audit logging, event bus                   | API → Audit → Tests               |
| SLATE-204 | agent:backend + agent:security | system settings & feature flags                                       | Configuration → Isolation → Audit |

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

## Planning artifact map

| Phase 2 capability (Section 15)                                                  | First task                    |
| -------------------------------------------------------------------------------- | ----------------------------- |
| `database abstraction`                                                           | SLATE-200 (Kysely — ADR 001)  |
| `tenants`, `organizations`                                                       | SLATE-201                     |
| `users`, `roles`, `permissions`                                                  | SLATE-202                     |
| `API`, event bus                                                                 | SLATE-203                     |
| `audit`, `notifications`, `media`, `jobs`, `search abstraction`, `health checks` | SLATE-205+ (post-ADR backlog) |
| `settings`, `feature flags`                                                      | SLATE-204 (ADR 003)           |

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
