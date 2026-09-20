# Current Status

- Current Phase: **Phase 3 — Frontend Scaffold & Shared UI**.
- Phase 2 (**Slate Core**) is **100% complete** and its gate is closed: all nine
  capability packages are implemented and green — `@slate/database`, `@slate/auth`,
  `@slate/api`, `@slate/settings`, `@slate/jobs`, `@slate/notifications`,
  `@slate/media`, `@slate/search`, `@slate/observability` — supported by
  `@slate/config`, `@slate/tenant-context` and `@slate/testing`. The
  `Organization → User → Permission → Tenant record → API → Audit → Tests` chain
  (Section 31) holds.
- Last completed task: **SLATE-300 — Shared UI package & workspace app
  scaffolding** (ADR 008 is **Accepted**):
  - `packages/ui` (`@slate/ui`): semantic design tokens
    (`src/styles/tokens.css`, WCAG-AA contrast asserted by test), accessible
    primitives on Radix (Button, Input, Card family, Modal, ThemeProvider) and
    41 component/unit tests (roles, keyboard, axe).
  - `packages/api-client` (`@slate/api-client`): the browser client with typed
    error unions, request-id correlation, a hard tenant-input guard (Master Plan
    Section 13), the `/api/v1` prefix as a single constant, and a guarded server
    half (`/server`: the loud import guard plus the HMAC session codec). 27 unit
    tests + 6 integration tests driving the real handler through the mount.
  - `@slate/config`: the Tailwind v4 preset (`@slate/config/tailwind`) mapping
    `@theme inline` onto the tokens, the React ESLint layer with the
    `slate/no-server-import-in-client` boundary rule, and the `nextjs` /
    `react-library` tsconfig presets.
  - `apps/admin` + `apps/web`: Next.js 16 App Router apps rendering from
    `@slate/ui`, with the platform mounted at `/api/v1/[...path]` on their own
    origin (first-party session cookie), a CSP at the app boundary, and
    server-resolved theme (no first-paint flash). Both pass `next build`.
  - Known follow-up (documented, not lost): server-side request-id logging lands
    with the session middleware in SLATE-301; the client half is done and tested.
- Completed: **SLATE-301 — Authenticated app shell & session surfaces** per
  `docs/phase3-agent-tasks.md` and
  `docs/adr/009-authenticated-shell-and-session-surfaces.md` (**Accepted**);
  session hydration, two-layer route guards, permission-filtered navigation,
  tenant switcher with audit logging, and secure sign-out implemented across
  `apps/admin` and `apps/web`.
- Fixed: **CI Run #36** (`@slate/api-client:unit`) — the unit Vitest config now
  pins the project root to the package directory, so the suite is discovered
  from any working directory. From the repository root it previously exited 1
  with "No test files found"; it now runs 3 files / 37 tests green, and the
  per-workspace run is unchanged.
- Completed: **SLATE-302 — Admin feature modules** per
  `docs/phase3-agent-tasks.md` and
  `docs/adr/010-admin-feature-modules.md` (**Accepted**):
  - Tenant management (`/tenants`, `/tenants/[tenantId]`): membership-scoped
    listing with member counts, creation inside the actor's organization and a
    member detail view; a tenant outside the memberships is a not-found, never a
    re-scope; each creation leaves exactly one attributable audit row.
  - User & role administration (`/users`): tenant-scoped member list, roles with
    their permission keys, and role assignment guarded server-side — a role whose
    fresh permission set exceeds the actor's own is refused (403), changes
    nothing and writes no audit row.
  - Feature-flag overrides (`/features`): every declared flag with its effective
    value and source, per-tenant overrides set or cleared through
    `@slate/settings`, each change audited in one transaction.
  - System health (`/health`): the live and ready probes projected through a
    pure, unit-tested builder that carries a state word and the HTTP status only.
  - Shell wiring in `apps/admin` from the SLATE-301 pieces (`requireSession()`
    hydration), tenant-switch and sign-out route handlers, and the admin
    navigation entries for the four modules.
  - Tests: unit suites for the permission guard and the health projection plus an
    11-test PostgreSQL integration suite (isolation, audit attribution, escalation
    guard, flag precedence) behind the new `@slate/admin` Vitest presets.
  - Fix: `@slate/database` resolves its migrations directory defensively, so a
    Next.js screen that reaches the database no longer fails page-data collection.
- Next Task: **SLATE-303** per `docs/phase3-agent-tasks.md` (Playwright E2E,
  accessibility automation and UI quality gates); its contract is written now
  that its predecessor is green.
- Validation: **`npm run verify` completed with exit code 0 on 2026-09-20**
  (format:check, lint, typecheck, unit tests, integration tests, build — the
  build stage performs real production builds of both apps).
- Blockers: None.
