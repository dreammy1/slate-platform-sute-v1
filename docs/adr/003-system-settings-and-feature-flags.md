# 003 — System Settings & Feature Flags

- **Status:** Accepted
- **Date:** 2026-09-17
- **Deciders:** Slate architecture, security review
- **Tags:** settings, feature flags, configuration, tenancy, security, Phase 2
- **Master Plan refs:** Section 15 (Slate Core — `settings`, `feature flags`), Section 60 (feature flags), Section 13 (never trust client-provided IDs/state), Section 57 (database migration rules), Section 61 (observability — never log sensitive data), Section 65 (adversarial cases), Section 67 (ADR system), Section 68 (no feature gaps), docs/phase2-agent-tasks.md (SLATE-204)

## Context

Phase 2 (Slate Core) lists `settings` and `feature flags` among the core capabilities (Section 15, Section 31). Section 60 is explicit about the required shape:

> Use server-authoritative flags … Flags allow controlled rollout without changing entitlement logic.

Today the platform has **no** configuration store. `packages/database` owns only the Phase 2 core tables (`organization`, `tenant`, `app_user`, `role`, `permission`, `role_permission`, `tenant_membership`, `audit_log`, `slate_migrations`), and `packages/api` (SLATE-203) exposes exactly one route pair (`GET`/`POST /users`) on the tenant-aware handler chain.

Without an explicit decision, configuration drifts into one of three unsafe places: environment variables (not tenant-scoped), ad-hoc per-module tables (unreviewable, and each one re-answers the isolation question), or client-bundled constants (violates Section 13 — the frontend is never authoritative). A flag read from the client would also let one tenant enable behaviour intended for another (Section 65).

Two shapes must be decided separately, because they answer different questions:

- a **setting** is tenant-owned _data_ (locale, timezone, branding) — the tenant's value is the answer; and
- a **flag** is a _rollout switch_ — the server decides, and the tenant may only override a default the platform owns.

## Decision

### One tenant-scoped configuration store, two tables

Add two tables, both carrying `tenant_id uuid NOT NULL` and both registered in `TENANT_OWNED_TABLES` so they are reachable **only** through the SLATE-200 scoped helper `db(tenantId)`:

- `system_setting` — `(tenant_id, key)` unique; a typed value.
- `feature_flag` — `(tenant_id, key)` unique; a per-tenant **override** of a platform-owned flag definition.

Isolation is therefore inherited, not re-implemented: a settings read/write cannot cross tenants because the wrong tenant is not expressible at the call site (the same property SLATE-201 established for the core tables).

### Keys are dotted and namespaced; values are typed

Keys follow the Section 60 examples (`feature.restaurant.v1`, `feature.new-checkout`) and the platform's `resource.action` convention (`branding.locale`, `booking.timezone`): dotted, namespaced, length-capped, and validated before any query. Values are stored as `jsonb` alongside an explicit `value_type` discriminator (`string | number | boolean | json`), validated on write and parsed on read, so a setting is returned with the type it was written with rather than a stringified approximation.

### Flag definitions are code-owned; the table stores overrides

The platform owns flag **definitions** in code — a registry of `key → { description, default_enabled }` (for example `feature.restaurant.v1`, `feature.ai.assistant`). The `feature_flag` table stores _only_ per-tenant overrides.

Resolution is `tenant override → definition default → false`, resolved by the server on every call:

- a defined flag with no override resolves to its registry default;
- an **unknown** key resolves to `false` and never throws — the system fails closed rather than enabling behaviour nobody declared; and
- a client cannot assert a resolved flag state. Only `PUT /features/:key`, authorized with `features.write`, accepts `{ enabled: boolean | null }` as an override command; `null` clears the override.

Keeping the definition in code means adding a flag needs no migration, and means the set of flags a deployment can honour is reviewable in the pull request that introduces them (Section 57: schema changes are deliberate, not the price of a flag).

### Server-authoritative reads, permission-gated writes

Reads and writes require tenant-scoped permission keys seeded like SLATE-202's `users.read`/`users.write`:

```text
settings.read   settings.write   features.read   features.write
```

The SLATE-203 handler chain is extended with the same gate order — context → authz → `db(tenantId)` → audit → events — so a request with no valid tenant context is still rejected with 401/403 **before any query**:

- `GET /settings` (`settings.read`) — the resolved tenant's settings.
- `PUT /settings/:key` (`settings.write`) — upsert one setting.
- `GET /features` (`features.read`) — the resolved tenant's resolved flag map.
- `PUT /features/:key` (`features.write`) — set or clear a declared flag's tenant override; the response is resolved server-side.

### Events after commit

Two events are added to the SLATE-203 in-process bus, published **after** the transaction commits (never before, so a rolled-back write cannot announce itself):

```text
settings.updated      { tenantId, key, actorUserId }
feature.flag.updated  { tenantId, key, actorUserId }
```

Payloads carry the **key**, never the value: a setting may hold sensitive tenant data, and Section 61 forbids putting sensitive customer data in logs or events.

### Audit

A write is a mutation, so it is non-optional and follows SLATE-203 exactly: exactly one `audit_log` row per accepted write, attributed to the tenant and the server-derived actor, written **inside** the same transaction — a failure to audit rolls the write back.

## Security requirements

- **Section 13 — never trust client state.** The tenant id comes from the resolved context only; ids in the body, query string or `X-Tenant-Id` alone are never trusted. The client cannot supply a tenant id or a trusted resolved flag state; authorized override commands are the sole exception for accepting `enabled`.
- **Section 60 — server-authoritative.** The flag map is computed server-side for the session's tenant on every call.
- **Section 65 — adversarial cases.** Tenant A cannot read or write tenant B's settings or overrides; a user without the matching permission is rejected before any write; an unknown flag key resolves to `false` (fail closed, no throw); and a permission revoked mid-session takes effect immediately — the same no-caching rule the SLATE-202 evaluator already follows.
- **Section 61 — redaction.** Values pass through the logger's redaction layer on the way out, and event payloads never include them.

## Out of scope

- Settings / feature-flag **UI** — the Phase 4 admin shell owns presentation.
- **Flag targeting rules** — per-user flags, percentage rollout, scheduling and experiments are a later ADR. SLATE-204 ships tenant-level booleans only.
- **Entitlements and licensing** (Phase 6) — Section 60 is explicit that flags exist so rollout does not change entitlement logic; a flag must never become the entitlement check.
- **Plugin-registered settings** (`registerSettings()`, Section 17) — Phase 5 plugin SDK.
- **Secret storage / KMS** — settings are configuration, not a secret store.
- Caching (see Consequences).

## Consequences

- **Positive:** one reviewable place for tenant configuration; isolation inherited from `db(tenantId)` rather than re-argued per module; a flag can be flipped without a migration and without touching entitlement logic; unknown flags fail closed.
- **Negative / accepted costs:** adding a flag requires a code change (deliberate — it keeps the flag surface reviewable); a settings or flag read costs a DB round trip per call until a caching ADR lands.
- **Follow-up constraint:** any cache added later must preserve Section 65 — a flipped flag or revoked permission must not be served from a stale copy.

## Acceptance criteria

- Tenant A cannot read or write tenant B's `system_setting` or `feature_flag` rows, through the API _or_ the scoped helper.
- Every route requires its matching permission key; an unauthorized member receives 403 and nothing is written.
- An accepted write commits exactly one attributed `audit_log` row in the same transaction, and its event is published only after commit.
- An unknown flag key resolves to `false`; a defined flag with no tenant override resolves to its registry default.
- A setting round-trips with its original type; an invalid or over-long key is rejected before any query.
- Unit suite covers resolution + value validation + the failure modes; the integration suite runs in an isolated schema (via `@slate/testing/postgres`) and proves isolation, the audit row and rollback.
- `npm run verify` is clean (Section 64: TypeScript, lint, unit, integration, build all at zero errors).
