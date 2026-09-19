# Phase 3 — Frontend Scaffold & Shared UI: Agent Task Contracts

Master Plan references: Section 10 (Agent Task Contract), Section 4 (Recommended
Technology Stack), Section 13 (Security Architecture), Section 33 (Phase 4 — Admin

- Customer Shell), Section 58 (API Contract Rules), Section 64 (Automated Quality
  Gates), Section 65 (Adversarial Tests for Every Important Feature), Section 67 (ADR
  System), Section 70 (Phase Gate Automation), Section 73 (What Must Be Built First).

Architecture reference: [`docs/adr/008-frontend-architecture-and-ui-system.md`](adr/008-frontend-architecture-and-ui-system.md)
(**Accepted**) governs every task below, with
[`docs/adr/009-authenticated-shell-and-session-surfaces.md`](adr/009-authenticated-shell-and-session-surfaces.md)
(**Accepted**) governing SLATE-301 and
[`docs/adr/010-admin-feature-modules.md`](adr/010-admin-feature-modules.md)
(**Proposed**) governing SLATE-302.

## Phase 2 gate: closed

Phase 2 (**Slate Core**) is complete and its gate is green. All nine capability
packages are implemented, tested and passing:

| Package                 | Capability delivered                           | Task      |
| ----------------------- | ---------------------------------------------- | --------- |
| `@slate/database`       | Kysely abstraction, migrations, tenant scoping | SLATE-200 |
| `@slate/tenant-context` | Tenant/organization context & isolation        | SLATE-201 |
| `@slate/auth`           | Users, roles, permissions, authorization       | SLATE-202 |
| `@slate/api`            | Tenant-aware API, audit, events, health probes | SLATE-203 |
| `@slate/settings`       | System settings & feature flags                | SLATE-204 |
| `@slate/jobs`           | Durable background jobs & task queue           | SLATE-205 |
| `@slate/notifications`  | Transactional notifications                    | SLATE-206 |
| `@slate/media`          | Media & file storage engine                    | SLATE-207 |
| `@slate/search`         | Search abstraction & health checks             | SLATE-208 |

Supporting shared packages: `@slate/observability`, `@slate/config`,
`@slate/testing`. `npm run verify` (format:check → lint → typecheck → unit →
integration → build) exits 0 on the merged state, and CI Run #29 is green: the
`Organization → User → Permission → Tenant record → API → Audit → Tests` chain of
Section 31 holds.

## Phase numbering and scope

The Master Plan slices phases differently from this repository's phase documents.
Section 32 names "Phase 3 — Authentication + Tenancy + RBAC", but that capability
was delivered here inside Phase 2 as SLATE-202 and SLATE-203. Section 73 fixes the
dependency order as `... → Core → Auth/Tenancy/RBAC → UI Shell → Plugin Engine`,
and Auth/Tenancy/RBAC is done — so the next step in the plan's own order is the
**UI Shell**.

This repository's **Phase 3** is therefore that step: the scaffold and shared UI
described by Section 33 (Admin + Customer Shell) and Section 4 (the frontend
technology stack). Nothing in Phase 3 re-opens the server-side decisions of
Phase 2; every screen consumes them.

> Issue IDs use the `SLATE-300` series for Phase 3. They are placeholders for the
> real GitHub issues created from this plan; branch names follow
> `SLATE-300-<slug>` (Section 7).

## Task index

| Issue     | Agent                           | Capability                                                  | Gate link                         |
| --------- | ------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| SLATE-300 | agent:frontend + agent:security | shared UI package & workspace app scaffolding               | Shell → Tenant data → API → Audit |
| SLATE-301 | agent:frontend + agent:security | authenticated app shell & session surfaces                  | Session → Permission → Shell      |
| SLATE-302 | agent:frontend + agent:security | admin feature modules: tenants, users/roles, flags, health  | Settings → Flags → Audit → UI     |
| SLATE-303 | agent:qa + agent:frontend       | Playwright E2E, accessibility automation & UI quality gates | E2E → A11y → Gate                 |

**SLATE-300** (done), **SLATE-301** (done) and **SLATE-302** are contracted in
detail below. The remaining row is a deliberately un-contracted placeholder: each
contract is written when its predecessor is green, so no agent widens its own
boundary or starts on an unapproved dependency (Sections 2, 7, 10).

---

## SLATE-300 — Shared UI package & workspace app scaffolding

- **Owning agent:** `agent:frontend` (with `agent:security` review of the client
  and boundary rules — Section 9)
- **Milestone:** M3 Frontend
- **Dependencies:** the Phase 2 gate is green (SLATE-200 … SLATE-208); ADR 008 is
  **accepted**. Implementation may not begin while ADR 008 is Proposed.
- **Scope:** stand up the frontend workspace: the shared design system
  (`packages/ui`) with tokens and accessible primitives, the typed API client and
  its server guard (`packages/api-client`), the Tailwind preset in
  `@slate/config`, and the two Next.js App Router applications (`apps/admin`,
  `apps/web`) with the platform API mounted at the versioned prefix. Render the
  application shell in both apps from **real** tenant data resolved through the
  session — never from fixtures. Prove the boundary rules with tests: the browser
  cannot choose its tenant, hidden controls are still protected server-side, and
  the server client cannot be imported into a client component.
- **Out of scope:** no feature screens beyond a minimal, real-data shell for each
  app (dashboards, user/role management, settings editors, feature-flag toggles,
  job and media browsers, command search and the notification centre are
  SLATE-301/SLATE-302); no Playwright E2E suites, no pixel/visual regression
  tooling (SLATE-303); no theme or template runtime (§15, later phase); no
  plugin-supplied UI (§16/§17); no authentication _flows_ beyond consuming the
  existing session (registration, MFA, email verification and password reset
  screens are their own follow-on task if the Master Plan requires them); no new
  API routes and no schema changes; no i18n; no vertical module UI.
- **Allowed files/packages:**
  - `packages/ui/` (new)
  - `packages/api-client/` (new; see the scope note in ADR 008 §1 — flagged for
    review, and the reviewer may instead fold it into `packages/ui` for now)
  - `apps/admin/`, `apps/web/` (new)
  - `packages/config/tailwind/` (new preset; plus `packages/config/eslint/react.js`
    for the React/Next.js lint entry point and its `package.json` `exports`)
  - `docs/adr/008-frontend-architecture-and-ui-system.md` (status only, on
    acceptance)
  - root `package.json` / `package-lock.json` (workspace scripts and the pinned
    frontend dependency graph)
  - `packages/api/openapi.json` (only to document the versioned prefix
    reconciliation; no route semantics change)
- **Contracts:**
  - **Package contract:** `apps/*` → `@slate/ui` and `@slate/api-client`;
    `@slate/ui` → React + Radix only, never a server package; `packages/*` never
    import from `apps/*`.
  - **API contract:** the existing routes, unchanged. The browser reaches them
    through `/api/v1/[...path]` mounted on `createHttpHandler`; Server Components
    reach them in-process through `createApi`. The client's types are derived from
    `packages/api/openapi.json`.
  - **Style contract:** `packages/ui/src/styles/tokens.css` is the single source of
    token values; `@slate/config/tailwind` is the single preset and must include
    `packages/ui/src/**` in its `content` globs.
  - **Logging contract:** client and server failures report through the
    `@slate/observability` contract with a request id; no `any`, no unlabelled
    console output.
- **Security requirements:**
  - Section 13: the tenant is resolved from the session server-side. No client
    code sends a tenant id from a form, URL, storage or a cookie it can read, and
    `X-Tenant-Id` may only mirror the session tenant.
  - Authorization is server-side on both entry points: the mounted
    `/api/v1/[...path]` route runs the existing `context → authz → db(tenantId)`
    chain, and `middleware.ts` is used for redirect convenience only, never as the
    authorization boundary.
  - Permission checks in the UI may hide a control, never authorize one; every
    hidden control's route remains protected when called directly.
  - The server client is guarded so an accidental browser import fails loudly; the
    session stays in an `httpOnly` cookie; nothing sensitive is written to
    `localStorage`/`sessionStorage`; server-only environment variables are never
    referenced from client code.
  - Tenant-authored text is rendered as text (no `dangerouslySetInnerHTML`), and a
    Content-Security-Policy is set at the app boundary.
  - Section 61: no tenant data, session value or token in logs; a request id
    correlates a browser action with the API's audit row.
- **Acceptance criteria:**
  - `npm ci` from a clean clone resolves every new workspace, and `npm run verify`
    is green with the new packages and apps included.
  - Both apps start and render an authenticated shell for a signed-in principal
    using **real** tenant data (organization, tenant, user, permissions and at
    least one live read such as settings or jobs) — a fixture-backed shell does not
    satisfy this.
  - An unauthenticated request to a protected route is refused server-side; a
    request naming a tenant the principal is not a member of is refused, not
    silently re-scoped.
  - The same browser action that succeeds through the UI leaves exactly one
    attributable `audit_log` row through the mounted API route — proving the
    browser did not get a bypass.
  - Importing the server client from a `'use client'` module fails: the guard
    throws and the ESLint restriction reports.
  - `@slate/ui` has no dependency on any server package, verified by a test and by
    the ESLint restriction.
  - Token pairs meet WCAG AA contrast; every composed component passes axe and is
    operable by keyboard with correct roles and accessible names.
  - Dark mode renders without a first-paint flash, and the token layer is the only
    place colour values are declared.
  - The CI `build` job performs a real production build of both apps.
- **Tests required:** unit tests for the client (typed error union, request-id
  propagation, tenant-header rules) and the server guard; component tests for every
  composed primitive (roles, keyboard, axe); a test asserting the token/literal
  colour rule and the AA contrast pairs; integration-style tests proving tenant
  isolation, server-side refusal and audit attribution through the mounted route.
  Use the existing `@slate/testing` presets; no new test framework.
- **Definition of Done (Section 12):** ADR 008 accepted; every criterion above
  demonstrated by a test; `npm run verify` clean; the phase gate cells
  (API/Permission/Tenant/Audit/Events/Tests) covered; `DEVELOPMENT_STATE.md`
  updated; contract for SLATE-301 written only after this task is green.

---

## SLATE-301 — Authenticated app shell & session surfaces

- **Owning agent:** `agent:frontend` (with `agent:security` review of session,
  switcher, and guards — Section 9)
- **Milestone:** M3 Frontend
- **Dependencies:** SLATE-300 green; ADR 008 **Accepted**; ADR 009 **Proposed**
  (implementation may not begin while ADR 009 is unaccepted; accept it first
  per Section 67).
- **Scope:** build the authenticated shell in both apps from real session data:
  server session hydration, navigation layout (sidebar plus topbar), tenant
  switcher, user profile tray with sign-out, and two-layer route protection
  guards. All reads go through the mounted `/api/v1` handler or in-process
  `createApi`; the browser holds no authority (ADR 008 plus ADR 009).
- **Out of scope:** dashboard and portal content, settings editors, flag
  toggles, job and media browsers, command search and notification centre
  beyond shell placeholders (SLATE-302); Playwright E2E (SLATE-303); theme or
  template runtime (Sec 15, later phase); plugin UI (Sec 16/17); sign-in,
  registration, MFA, recovery screens (follow-on if required); new API routes,
  schema changes, i18n, vertical module UI.
- **Allowed files/packages:**
  - `apps/admin/src/app/**/layout.tsx`, `apps/web/src/app/**/layout.tsx`
  - `apps/admin/src/server/`, `apps/web/src/server/` (session hydration only)
  - `apps/admin/src/app/api/`, `apps/web/src/app/api/` (switch and sign-out
    actions only; no new platform routes)
  - `packages/ui/` (shared presentational shell pieces only; no session reads)
  - `packages/api-client/` (re-export session helpers only; no codec changes
    unless ADR 009 requires them)
  - `docs/adr/009-authenticated-shell-and-session-surfaces.md` (status only, on
    acceptance)
  - root `package.json` / `package-lock.json` (workspace scripts only)
- **Contracts:**
  - **Session contract:** `requireSession()` per app resolves `{ user, tenants,
activeTenantId, permissions, requestId }` server-side from `slate_session`
    via `createSessionCodec.verify` plus fresh `getCurrentUser`, membership,
    and `getPermissionsForUser` reads. Props cross the boundary; cookie value,
    secret, codec, DB handle never do.
  - **Tenant contract:** verified payload `tenantId` wins; any other requested
    tenant is 403, never re-scoped. Switch re-reads membership, refuses
    non-members (403), re-issues with identical cookie attributes, leaves one
    audit row.
  - **Nav contract:** entries declare a permission key; server layout filters
    with `hasPermission` per request; direct fetches re-check.
  - **Guard contract:** protected by default; public routes enumerated; layout
    redirect plus `/api/v1` re-check; client hiding is UX only.
  - **Style contract:** ADR 008 tokens, preset, CSP, server theme, AA, axe, and
    keyboard invariants extend to every shell piece.
  - **Logging contract:** request-id correlation (Section 61); no tenant data,
    session value, or token in logs; no `any`, no unlabelled console output.
- **Security requirements:**
  - Section 13: tenant and user ids are server-resolved; switch options come
    from membership rows only; client sends no tenant id it can author.
  - Fresh permission reads per request (no session permission cache); hidden
    nav stays refused on direct fetch; server import in a client module still
    throws (guard plus ESLint).
  - Session stays `httpOnly` (`SameSite=Lax`, `Secure`, `Path=/`); nothing
    sensitive in web storage; server env never referenced from client code;
    tenant text as text; CSP at the boundary.
- **Acceptance criteria:**
  - `npm ci` from a clean clone resolves every workspace; `npm run verify`
    green with the new surfaces included.
  - Both apps render the shell for a signed-in principal from real tenant data
    (user, org, tenant, permissions, one live read); fixtures do not satisfy.
  - Switch to a non-member tenant is refused (403); unauthenticated protected
    route redirects server-side; under-permissioned route is refused even on
    direct fetch.
  - Each audited switch leaves exactly one attributable audit row through the
    mounted route; rival-tenant payload never renders mid-switch.
  - Shell pieces are axe-clean, keyboard-operable, AA, flash-free themed, with
    no sensitive value in web storage.
  - CI `build` performs a real production build of both apps.
- **Tests required:** hydration from a real signed session; switch refusal and
  audit attribution; unauthenticated redirect; permission-filtered nav plus
  direct-fetch refusal; web-storage absence; component tests (roles, keyboard,
  axe) for every shell piece. Existing `@slate/testing` presets; no new
  framework.
- **Definition of Done (Section 12):** ADR 009 accepted; every criterion above
  demonstrated by a test; `npm run verify` clean; phase-gate cells
  (API/Permission/Tenant/Audit/Events/Tests) covered; `DEVELOPMENT_STATE.md`
  updated; contract for SLATE-302 written only after this task is green.

---

## SLATE-302 — Admin feature modules (tenants, users/roles, flags, health)

- **Owning agent:** `agent:frontend` (with `agent:security` review of tenant,
  RBAC and flag mutations — Section 9)
- **Milestone:** M3 Frontend
- **Dependencies:** SLATE-301 green; ADR 008 **Accepted**; ADR 009 **Accepted**;
  ADR 010 **Proposed** (implementation may not begin while ADR 010 is
  unaccepted; accept it first per Section 67).
- **Scope:** build the `apps/admin` feature modules on the SLATE-301 shell from
  real server data — tenant management, user and role administration, feature
  flag overrides, and system health dashboards — each permission-gated,
  tenant-scoped and audited. All reads and writes run through the mounted
  `/api/v1` handler or in-process `createApi`; the browser holds no authority
  (ADR 008, ADR 009, ADR 010).
- **Out of scope:** Playwright E2E and accessibility automation (SLATE-303);
  customer-portal content beyond the shell; theme or template runtime (§15);
  plugin-supplied UI (§16/§17); sign-in, registration, MFA and recovery screens;
  the audit-log viewer, billing and data export; new platform routes, schema
  changes or migrations; i18n; vertical module UI.
- **Allowed files/packages:**
  - `apps/admin/src/app/**` (module routes, pages and layouts)
  - `apps/admin/src/server/` (server-only data loading for module screens)
  - `packages/ui/` (shared presentational module pieces only; no session reads)
  - `packages/api-client/` (client helpers and route constants only; no
    authority, no codec changes)
  - `docs/adr/010-admin-feature-modules.md` (status only, on acceptance)
  - root `package.json` / `package-lock.json` (workspace scripts only)
- **Contracts:**
  - **Nav/permission contract:** every module entry declares a permission key;
    the server layout and each page re-check with a fresh `hasPermission` read;
    direct fetches re-check (ADR 009 §2, §5).
  - **Tenant contract:** the acting tenant and organization are server-resolved
    from the session; no form, URL, header or storage value may choose a tenant
    (Section 13); a cross-tenant read or write is refused, never re-scoped.
  - **RBAC contract:** role and permission mutations are gated by administrative
    keys; an actor may only grant permissions it holds (fresh read), so no
    self-widening; revoked grants take effect on the next request.
  - **Flags contract:** flag overrides use the existing `@slate/settings` store;
    effective value = tenant override else global default; the source is shown;
    no new flag storage (Section 18).
  - **Health contract:** the dashboard aggregates existing Phase 2 probes per
    request; no privileged probe, no bypass, and no secret or raw error body in
    the response or the DOM.
  - **Audit contract:** each admin write leaves exactly one attributable
    `audit_log` row (actor, tenant, resource, request id) through the mounted
    route.
  - **Style contract:** ADR 008 tokens, preset, CSP, server theme, AA, axe and
    keyboard invariants extend to every module screen.
  - **Logging contract:** request-id correlation (Section 61); no tenant data,
    session value, secret or token in logs; no `any`, no unlabelled console
    output.
- **Security requirements:**
  - Section 13: tenant, user, role and flag writes are server-authorized;
    client hiding is UX only and never the boundary.
  - Fresh permission reads per request (no cached grants); the escalation guard
    is enforced server-side; hidden controls stay refused on direct fetch.
  - No sensitive value in web storage or client logs; server env never
    referenced from client code; tenant-authored text rendered as text; CSP at
    the app boundary.
- **Acceptance criteria:**
  - `npm ci` from a clean clone resolves every workspace; `npm run verify` green
    with the new modules included.
  - Each module renders from real tenant data (users, roles, permissions, flags,
    probe results); fixtures do not satisfy.
  - Cross-tenant access is refused (403/404 per policy); an under-permissioned
    route is refused even on direct fetch; a non-member tenant switch is
    refused.
  - Every admin write leaves exactly one attributable audit row through the
    mounted route; an actor cannot grant a permission it does not hold.
  - Flag overrides resolve override over default and report their source; health
    output is sanitized (no secret, connection string or stack trace).
  - Module screens are axe-clean, keyboard-operable, AA, flash-free themed, with
    no sensitive value in web storage.
  - CI `build` performs a real production build of both apps.
- **Tests required:** tenant-scoped read and refusal; RBAC authorization plus
  the escalation guard; flag precedence and source reporting; sanitized health
  aggregation; permission-filtered nav plus direct-fetch refusal; audit
  attribution per write; component tests (roles, keyboard, axe) for every module
  screen. Existing `@slate/testing` presets; no new framework.
- **Definition of Done (Section 12):** ADR 010 accepted; every criterion above
  demonstrated by a test; `npm run verify` clean; phase-gate cells
  (API/Permission/Tenant/Audit/Events/Tests) covered; `DEVELOPMENT_STATE.md`
  updated; the SLATE-303 contract written only after this task is green.

## Planning artifact map

| Phase 3 capability (Sections 4, 33)                       | First task                     |
| --------------------------------------------------------- | ------------------------------ |
| shared design system, tokens, accessible primitives       | SLATE-300 (done)               |
| Next.js App Router scaffolding (`apps/admin`, `apps/web`) | SLATE-300 (done)               |
| typed/versioned API client integration (§58)              | SLATE-300 (done)               |
| application shell, sidebar, topbar                        | SLATE-301 (done)               |
| command search, notification centre, profile, settings    | SLATE-301 (done) / SLATE-302   |
| admin feature modules, customer portal, responsive UI     | SLATE-302 (ADR 010 — Proposed) |
| accessibility automation, Playwright E2E (§4, §64, §65)   | SLATE-303                      |
| theme runtime, template runtime (§15)                     | later phase (not Phase 3)      |
| plugin-supplied UI surfaces (§16, §17)                    | later phase (not Phase 3)      |
