# 008 — Frontend Architecture & UI System

- **Status:** Proposed — implementation (SLATE-300) starts only once accepted (Section 67).
- **Date:** 2026-09-19
- **Deciders:** Slate architecture, security review, frontend
- **Tags:** frontend, Next.js, App Router, Tailwind CSS, accessibility, design tokens, API client, Phase 3
- **Master Plan refs:** Sections 4 (Recommended Technology Stack), 13 (Security Architecture), 15 (Slate Core), 33 (Phase 4 — Admin + Customer Shell), 58 (API Contract Rules), 61 (Observability), 64 (Automated Quality Gates), 65 (Adversarial Tests), 67 (ADR System), 70 (Phase Gate Automation), 73 (What Must Be Built First); ADR 007; SLATE-300 in `docs/phase3-agent-tasks.md`

## Context and sequencing

Phase 2 delivered Slate Core: nine capability packages (`@slate/database`,
`@slate/auth`, `@slate/api`, `@slate/settings`, `@slate/jobs`,
`@slate/notifications`, `@slate/media`, `@slate/search`, `@slate/observability`),
supported by `@slate/config`, `@slate/tenant-context` and `@slate/testing`. The
server side is complete and green; no browser has ever talked to it.

Section 73 fixes the dependency order and places **UI Shell** immediately after
Auth/Tenancy/RBAC — both of which this repository already shipped (SLATE-202,
SLATE-203) inside its own Phase 2. Section 33 describes what that shell must
contain (application shell, sidebar, topbar, command search, notifications,
profile, settings, admin dashboard, customer portal, responsive and accessible)
and requires that it "use real authentication, permissions and tenant data"
rather than fixtures. Section 4 already names the stack: Next.js with the App
Router, Server Components where appropriate, server-side authorization, Tailwind
CSS, shadcn/ui, an accessible component system, design tokens, light/dark
support and Playwright E2E.

Two facts shape this decision. First, `apps/` is empty — every UI choice is still
cheap to make and expensive to defer, because a scaffold that handles tenancy or
authorization wrongly is copied into every later screen. Second, the frontend
groundwork already exists in the monorepo and should be adopted rather than
reinvented: `@slate/config` already exports `tsconfig/nextjs.json` (DOM lib,
`jsx: preserve`, the Next.js TS plugin) and `tsconfig/react-library.json`, its
ESLint base already ignores `.next`/`out`/`build`, and the `@slate/testing`
presets already match `**/*.test.tsx` and support a `jsdom` environment.

The load-bearing risk is not styling. It is that the browser is the one place
where Section 13 ("never trust client-provided tenant IDs, object IDs, frontend
permissions") is trivially violated, because a frontend _wants_ to hold the
tenant, the permission list and the object id in hand. This ADR therefore treats
the API client and the server/client boundary as the primary decision, and the
design system as the secondary one.

## Architectural choices

| Option                                                           | Integration                                                                                      | Cost and risk                                                                                         | Decision                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------- |
| Static HTML/CSS with server-rendered tables                      | Trivial                                                                                          | Cannot express the interactive shell of Section 33; replaced almost immediately                       | Reject                    |
| Plain React SPA (Vite) with client-side data fetching            | Familiar; `@slate/api` handlers are plain functions                                              | Pushes tenant, permission and authorization decisions into the browser, contradicting §4              | Reject                    |
| Next.js **Pages Router**                                         | Mature ecosystem                                                                                 | §4 names the App Router, and the `server-only` boundary is the mechanism this ADR depends on          | Reject                    |
| Next.js **App Router** + Server Components                       | Authorization and tenant resolution happen where the session already is; one typed server client | Requires discipline about the `'use client'` boundary and about what may cross it                     | **Propose for SLATE-300** |
| Bespoke CSS / CSS-in-JS runtime                                  | Full control, no token pipeline                                                                  | No shared tokens for the theme runtime later phases need (§15 `theme runtime`)                        | Reject as system layer    |
| **Tailwind CSS with design tokens** in one shared preset         | Tokens are CSS custom properties; every app consumes them and theming can override them later    | One canonical token source, and a content-glob rule so library classes are not purged                 | **Propose for SLATE-300** |
| **Radix primitives + source-owned components** (shadcn/ui style) | Accessible behaviour without owning dialog, menu, popover and focus-trap correctness             | Component source lives in the repo and is reviewed and upgraded like any other code                   | **Propose for SLATE-300** |
| Buy a published component library (MUI, Mantine, Chakra)         | Fastest first screen                                                                             | Locks visual identity and theming to a vendor, conflicting with the theme runtime; §4 names shadcn/ui | Reject                    |
| Global client store (Redux/Zustand) as the default data layer    | Convenient for cross-screen state                                                                | Duplicates server state, invites client-side authorization and creates a second source of truth       | Reject as the default     |

No frontend dependency is installed by this planning change: the rows above are
architectural positions, not verified version claims. Exact versions are pinned
through `package-lock.json` by SLATE-300, together with whatever configuration
format the pinned major of Tailwind requires.

## Proposed decision

### 1. Workspace topology

Three new workspaces, with a strictly one-way dependency direction:

```text
apps/admin  ─┐
apps/web    ─┴─→  @slate/ui  ─→  (React, Radix, tokens)
                └─→  @slate/api-client  →  (types only)
```

- **`packages/ui` (`@slate/ui`)** — the shared design system: design tokens,
  accessible primitives and composed components. It must not depend on
  `@slate/api`, `@slate/api-client`, `@slate/database`, `@slate/jobs` or any
  other server package, and it must not render tenant or permission logic.
- **`apps/admin` (`@slate/admin`)** — the authenticated tenant shell of Section 33:
  dashboard, settings, users, jobs, media, search.
- **`apps/web` (`@slate/web`)** — the customer/public surface: public routes plus
  the authenticated customer portal of Section 33.
- **`packages/api-client` (`@slate/api-client`)** — the typed client and the
  server/client boundary guard. See the scope note below.

The direction is enforced, not documented: a core ESLint `no-restricted-imports`
rule set (no plugin required) forbids `apps/**` and `packages/ui/**` from
importing the server packages, and forbids importing the server client from a
module marked `'use client'`. `packages/*` never import from `apps/*`.

Deviating from the current tree, the Tailwind preset belongs in
**`@slate/config`** (`packages/config/tailwind/preset.cjs`, exported as
`@slate/config/tailwind`), because that package already owns shared ESLint,
Prettier and tsconfig configuration and its `files` list is the established place
for tooling config; the _token values_ live in `packages/ui/src/styles/tokens.css`
because they are a runtime artifact the components consume.

**Scope note (flagged for review).** The SLATE-300 working title names only
`packages/ui`, `apps/admin` and `apps/web`. This ADR adds `packages/api-client`
because the alternative — a client module duplicated per app — directly
undermines the primary security decision below: the client's rules would then be
enforced in two places and drift in one of them. If the reviewer prefers, the
client may instead begin inside `packages/ui` and be extracted once a second
consumer exists; the rules that follow are identical either way.

### 2. App Router architecture

**Server Components are the default.** `'use client'` is reserved for genuinely
interactive leaves (a menu, a form control, a chart), each of which is a reviewed
boundary. Every boundary crossing carries data, never authority.

**Authorization is server-side only.** Each protected route resolves the session
cookie server-side, then runs the same chain the API runs (Section 13):
`context → authz → db(tenantId)`. The browser receives rendered output and never
receives a decision it could have made itself. A client-side permission check may
_hide_ a control; it never _authorizes_ one, and the server re-derives the answer
for every request regardless of what the UI showed.

**One pipeline, two entry points.** The platform API is already a
`(request) => response` function plus a thin Node adapter. SLATE-300 mounts it
unchanged, under the versioned prefix Section 58 requires:

```text
browser  ─→  POST /api/v1/[...path]   (Route Handler → createHttpHandler)
server   ─→  createApi({...}) in-process, with the session-derived principal
```

Both entry points reach the identical context → authorization → single-transaction
→ audit → post-commit-event chain, so a browser request is audited exactly like a
server one and no screen has a privileged back door to the database. Server
Components call the pipeline in-process because a loopback HTTP hop would add
latency and a second failure mode without adding a security property.

**Route conventions.** Route groups separate the authenticated shell from public
routes; each group owns `layout.tsx`, `loading.tsx`, `error.tsx` and
`not-found.tsx`. `middleware.ts` does cheap session-presence redirects only — it
is an optimization for user experience, never the authorization boundary.

**Tenant selection.** The active tenant lives in the session. A tenant switcher
POSTs to a Route Handler that re-scopes the session server-side and rejects a
tenant the principal is not a member of; the `X-Tenant-Id` header may only mirror
the session tenant, exactly as the API contract already states. A tenant id
supplied by a form, a URL segment or local storage is never honored.

**Caching.** Tenant-scoped data is fetched per request with caching disabled;
shared caches are never keyed without the tenant. Only genuinely public content
may be statically cached or revalidated.

**Rendering safety.** Tenant-authored text is rendered as text; no
`dangerouslySetInnerHTML` on tenant content, and a Content-Security-Policy is set
at the app boundary. Session cookies are `httpOnly` so the client cannot read the
session at all.

### 3. Tailwind CSS and the design token layer

The token layer is the contract; Tailwind is one consumer of it.

- **One canonical source:** `packages/ui/src/styles/tokens.css` declares the design
  tokens as CSS custom properties — colour, spacing scale, radius, typography,
  elevation, motion. Tokens are named **semantically**
  (`--slate-surface`, `--slate-danger`) rather than by literal palette position, so
  dark mode and the later theme runtime (§15 `theme runtime`) can re-map values
  without a single component changing.
- **One canonical preset:** `@slate/config/tailwind` maps Tailwind's theme onto
  those variables (`background: var(--slate-background)`), sets the dark-mode
  strategy, and carries **no** app-specific values. Its `content` globs must cover
  `packages/ui/src/**`; a preset that omits the library silently purges the very
  classes the components depend on.
- **Light and dark support (§4):** the class strategy (`dark` on the root element)
  driven by a stored preference with `prefers-color-scheme` as the initial value,
  resolved on the server so the first paint does not flash the wrong theme.
- **No literal colours outside the token file:** components and apps use tokens and
  semantic utilities. A repository test fails the build if a hex/rgb literal
  appears in app or component source outside `tokens.css`, and asserts that the
  documented token pairs meet the WCAG AA contrast ratio — colour choices become
  testable facts rather than review opinions.
- **Motion and responsiveness:** transitions come from tokens and honour
  `prefers-reduced-motion`; layout is mobile-first with the token breakpoints, as
  Section 33 requires responsive/mobile UI.

### 4. Accessible primitive system

- **Behaviour is bought, appearance is owned.** Radix primitives provide the
  interaction layer for dialogs, menus, popovers, tabs, tooltips, selects,
  switches and toasts — focus trapping, escape handling, roving tabindex and ARIA
  wiring are theirs. The component _source_ is copied into `@slate/ui` and owned
  here (the shadcn/ui distribution pattern), themed through tokens and Tailwind.
  shadcn/ui is therefore a pattern, not a runtime dependency; Radix is the
  runtime dependency.
- **No hand-rolled interaction logic.** If a required primitive has no Radix
  equivalent, that is a decision for this ADR, not something an agent reimplements
  from scratch inside a feature branch.
- **Accessibility is a gate, not an aspiration (Sections 64, 65):** target
  WCAG 2.2 AA. Semantic HTML first (a button is a `<button>`), full keyboard
  operability, visible focus, programmatically associated labels, no meaning
  conveyed by colour alone, and live regions for asynchronous results such as
  search. Component tests query by role and accessible name, run axe assertions,
  and exercise keyboard paths — a test that could pass without the right roles is
  not an accessibility test.
- **No authority in the UI package.** `@slate/ui` contains no tenant or
  permission logic: a component may render what it is told to render, and hiding
  a control is a user-experience affordance, never an authorization decision.
- **Server/client split is declared.** Primitives are client components;
  presentational components are server-safe. Each export is documented as
  server-safe or client-only and a test asserts the split, so an app never
  discovers the boundary at runtime.

### 5. Strict API client integration

The client is the security-critical artifact of the frontend, so its rules are
stated as invariants:

- **Typed from the contract.** The client's request and response types are derived
  from `packages/api/openapi.json` — the same artifact the API tests against — so a
  route change that breaks the frontend breaks the build instead of production.
  Section 58's versioning prefix (`/api/v1/...`) is applied at the app boundary,
  and the client is the single module that knows the prefix exists.
- **The browser never states its own tenant.** No client code sends a tenant id
  derived from a form, a URL, a cookie it can read, or local storage; the server
  resolves the tenant from the session. `X-Tenant-Id`, where the client sends it at
  all, may only mirror the session tenant, because a client-supplied tenant is
  untrusted by definition (Section 13).
- **Server-only by construction.** The server client lives behind an explicit
  server guard: the module begins with an import of a tiny guard module that throws
  if it is ever evaluated with a `window` present. Coupled with the ESLint
  restriction on `'use client'` modules, an accidental client-side import fails
  loudly in tests rather than shipping a privileged path to the browser.
- **No secrets and no tokens in the browser.** The session is an `httpOnly` cookie
  the client cannot read; nothing is persisted to `localStorage` or
  `sessionStorage`, and no server-only environment variable is referenced from
  client code (the build must fail if one is).
- **Errors are typed, not strings.** Transport, 400, 401, 403, 404, 409 and 500
  responses map onto a discriminated union, so a screen decides what to render
  without parsing messages — and a 403 from the server is never silently rendered
  as "not found" or vice versa.
- **Observability.** Every request carries a request id that the server logs, so a
  browser action can be traced to the API's audit row and log line (§61). Failures
  are reported through the shared logger contract, never as an unlabelled console
  error.
- **Fail closed, never optimistic.** A client-side permission flag may hide a
  control, but the server's answer is the only answer: an optimistic UI that
  assumes success and reconciles later is rejected for state-changing actions,
  because it renders an authorization decision the server has not made yet.

### 6. Verification

- **Unit and component tests** run through the existing `@slate/testing` preset
  with the `jsdom` environment it already supports, using Testing Library and axe
  assertions; `**/*.test.tsx` is already matched by the preset's include globs.
- **The React ESLint gap is closed as part of SLATE-300.** `@slate/config/eslint`
  currently exposes only `base` and `node`; the task adds a React/Next.js entry
  point extending the base, so JSX rules, hooks rules and the boundary
  restrictions apply to `apps/**` and `packages/ui/**`.
- **TypeScript configuration is adopted, not invented:** `apps/*` extends
  `@slate/config/tsconfig/nextjs.json`, `packages/ui` extends
  `@slate/config/tsconfig/react-library.json` (both already exist).
- **The build gate activates.** The CI `build` job already states it is inert until
  a workspace ships a build script; the first app that does turns it into a real
  gate, and no app may be added without one.
- **Adversarial tests (Section 65).** At minimum: a browser request cannot change
  the tenant it acts on; an unauthenticated request to a protected route is
  redirected or rejected server-side; hidden controls remain protected server-side
  when a client calls the route directly; a client-side store cannot forge a
  permission.
- **Playwright E2E is explicitly out of scope for SLATE-300.** Section 4 requires
  it eventually; it is a follow-on Phase 3 task (see the task index), and SLATE-300
  only reserves the seam by keeping routes addressable and deterministic.

## Consequences and out of scope

- Positive: one authorization model on both entry points, so a browser request is
  audited exactly like a server request; a shared token layer that the later theme
  runtime can re-map; accessible primitives that are reviewed once instead of
  re-implemented per feature; and a typed client that turns contract drift into a
  build failure.
- Costs: two frameworks to keep aligned (Next.js server semantics and the platform
  API), a source-owned component library to maintain and upgrade, and a stricter
  build (the first app build makes CI slower and adds real frontend build
  failures to the gate).
- **Deferred:** Playwright E2E suites, the command-search UX and notification
  centre beyond their shell placeholders, the full theme/template runtime (§15),
  plugin-supplied UI surfaces (§16/§17), i18n, and any vertical module UI
  (CRM, Booking, Commerce — Sections 37-44).
- **Not decided here:** the visual identity itself (brand palette, typography
  choices) beyond the requirement that it is expressed as tokens; and the
  versioned-prefix reconciliation between the app boundary and the currently
  unversioned paths in `packages/api/openapi.json`, which SLATE-300 must document
  rather than leave implicit.

## Acceptance and validation

The SLATE-300 contract is the implementation checklist. It must prove, with tests
rather than prose: tenant isolation across the client and the mounted API route, an
unauthenticated request being refused server-side, a client-supplied tenant id
being ignored, the server-guard failing an accidental client import, token-pair
contrast meeting AA, keyboard and role assertions on every composed component, and
the core flows rendering from real tenant data rather than fixtures. Migration,
API, Permission, Tenant, Events and Tests cells of the phase gate must be covered
before SLATE-300 is marked complete, and `npm run verify` must pass with the new
workspaces included.
