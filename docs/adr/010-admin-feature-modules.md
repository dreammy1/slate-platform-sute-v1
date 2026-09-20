# ADR 010 — Admin Feature Modules

- **Status:** Accepted — 2026-09-20. Approved with the SLATE-302 task contract;
  SLATE-302 implements this ADR.
- **Date:** 2026-09-20
- **Deciders:** Slate architecture, security review, frontend
- **Tags:** frontend, admin, tenancy, rbac, feature-flags, health, Phase 3
- **Master Plan refs:** Sections 4, 13, 33, 58, 61, 64, 65, 67, 70, 73; ADR 002;
  ADR 008; ADR 009; SLATE-302

## Context

SLATE-301 is green: both apps hydrate the session server-side, guard routes in
two layers, and render the shell. `apps/admin` currently shows the shell and
placeholder surfaces only. Section 33 assigns the Admin Shell the platform's
operational surfaces — tenant administration, user and role management, feature
flags and system health — and Section 73 sequences them after the UI shell.

The shell settled _how_ authority crosses the boundary (ADR 009): the browser
holds none, every read and write runs through `/api/v1` or in-process
`createApi`, and permissions are re-read per request. This ADR settles which
modules ship in `apps/admin`, what data they may touch, and the contracts they
must honour. It adds no new authority: every capability below already exists in
the Phase 2 packages (`@slate/auth`, `@slate/settings`, `@slate/api`,
`@slate/observability`).

## Decision

### 1. Modules are permission-gated screens under the existing shell

- Each feature module is a route group under `apps/admin/src/app/` rendered
  inside the SLATE-301 layout; no module ships its own shell, session read or
  guard.
- Every module declares the permission key its entries require. The server
  layout and each page re-check with a fresh `hasPermission` read; a hidden
  control's route is still refused on direct fetch (ADR 009 §2, §5).
- All data crosses the boundary as server-resolved props. Reads and writes go
  through the mounted `/api/v1` handler (browser) or `createApi` (Server
  Components); no module reaches the database directly and none mints a tenant
  id (Section 13).
- Writes are audited once, attributably, through the mounted route — actor,
  tenant, resource, request id (Sections 31, 61).

### 2. Tenant management

- Read: list the tenants the actor is a member of within their organization,
  with name, slug, status and member count. Reads are tenant-scoped by the
  resolution in `@slate/tenant-context`; another tenant's row is refused
  (403/404 per app policy), never silently re-scoped.
- Write: create, rename and deactivate a tenant within an organization, gated
  by an administrative permission key (for example `tenants.manage`). The
  acting tenant and organization are server-resolved from the session, never
  taken from the form.
- Lifecycle: create, rename, deactivate/archive. Deactivation is a status
  change that preserves rows and audit history and never cascades a hard delete.
- Every mutation leaves exactly one attributable audit row.

### 3. User and role administration

- Read: list the users in the active tenant with their memberships and roles;
  list the roles defined in the tenant and their permission keys.
- Write: invite or provision a user, add or remove a tenant membership, assign
  and revoke a role for a membership, and edit a role's permission set. All are
  gated by administrative permission keys and audited.
- Escalation guard: an actor may only grant a permission it itself holds at the
  time of the write (fresh read); the server enforces this and the UI merely
  hides the control. An actor can never widen its own privilege.
- Permission keys and the role-to-permission map are read from `@slate/auth`;
  the client never invents a key or caches a grant. Revoking a role takes effect
  on the next request (ADR 002, ADR 009 §1).
- Deleting a user is out of scope; users are deactivated so audit rows and
  foreign keys survive.

### 4. Feature flag overrides

- The module surfaces the effective feature flags for the active tenant and
  lets an administrator override a flag for that tenant.
- Storage is the existing `@slate/settings` feature-flag store — no new table
  and no second source of truth. Effective value = tenant override (if any)
  else the global default; the resolution order is documented and tested.
- Reads return the effective value plus its source (override vs. default) so
  the UI can show why a flag is on. Writes are gated by an administrative
  permission key and audited; no flag is toggled by a URL or query parameter.

### 5. System health dashboards

- The dashboard is read-only and aggregates the health probes that already
  exist: database, API, jobs, notifications, media, search and observability
  (the Phase 2 health endpoints). It adds no privileged probe and no bypass.
- Probe results are collected server-side per request (tenant-scoped where the
  probe is) and rendered as healthy/degraded state. No secret, connection string
  or raw error body leaves the server; failures surface as sanitized status,
  never as a stack trace or credential (Section 61).
- The dashboard is a presentation of server-resolved data; it holds no authority
  and asserts no state the probes did not report.

### 6. Cross-cutting invariants

- Accessibility, theming, CSP and token rules extend unchanged (ADR 008): axe
  clean, keyboard-operable, WCAG AA, server-resolved theme, tenant text as text.
- No sensitive value in web storage; server env never referenced from client
  code; request-id correlation on every surfaced failure.
- No `any`; no unlabelled console output; no new platform route, table or
  migration — the modules consume Phase 2 capabilities as-is.

## Alternatives considered

| Option                                                     | Risk                                           | Decision |
| ---------------------------------------------------------- | ---------------------------------------------- | -------- |
| A dedicated admin API with its own authorization           | A second authority to keep in sync (§5, §13)   | Rejected |
| Tenant/user writes scoped by a client-supplied tenant id   | Cross-tenant writes; forged scope (Section 13) | Rejected |
| A new feature-flag table owned by the admin app            | Two sources of truth for flags (Section 18)    | Rejected |
| A privileged "raw" health probe endpoint for the dashboard | Leaks secrets and internals past authorization | Rejected |
| Permission-gated modules over the existing API and stores  | More server renders; stricter tests            | Accepted |

## Consequences and out of scope

- Positive: one authority model end to end; admin capabilities reuse audited
  Phase 2 routes and stores; tenant isolation and RBAC stay single-sourced.
- Costs: fresh permission and probe reads per request; more screens, tests and
  build surface; slower admin pages by design.
- Deferred: customer-portal content beyond the shell; the command search and
  notification centre beyond their SLATE-301 placeholders; Playwright E2E
  (SLATE-303); theme and template runtime (Sec 15); plugin-supplied UI
  (Sec 16/17); i18n; vertical modules (Sec 37-44).
- Not decided here: sign-in, registration, MFA and recovery screens; the
  audit-log viewer; billing; data export.

## Acceptance and validation

SLATE-302 proves with tests: real tenant-scoped reads and refusals for
non-members; permission-filtered navigation that stays refused on direct fetch;
one attributable audit row per admin write; the escalation guard (no
self-widening); flag precedence (override over default) with the source
reported; sanitized probe output; and axe-clean, keyboard-operable, AA screens
with no sensitive value in web storage. Phase-gate cells
(API/Permission/Tenant/Audit/Events/Tests) covered; `npm run verify` passes.
