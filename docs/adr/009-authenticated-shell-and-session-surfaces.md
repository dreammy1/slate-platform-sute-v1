# ADR 009 — Authenticated Shell & Session Surfaces

- **Status:** Proposed
- **Date:** 2026-09-19
- **Deciders:** Slate architecture, security review, frontend
- **Tags:** frontend, session, shell, tenancy, guards, Phase 3
- **Master Plan refs:** Sections 4, 13, 33, 58, 61, 64, 65, 67, 73; ADR 002; ADR 008; SLATE-301

## Context

SLATE-300 is green: tokens, primitives, typed client, guarded server half
(HMAC session codec), and both apps mounting the platform at `/api/v1` with
CSP, server theme, and real `next build`. No layout reads the session yet.

Section 33 requires the shell use real auth, permissions, tenant data. Section
13 forbids trusting client tenant IDs. ADR 008 settled the boundary (browser
holds no authority); this ADR settles how the shell uses it.

## Decision

### 1. Session hydration: server reads, client receives data, never authority

- One server function per app (`requireSession()` in `apps/*/src/server/`, a
  Route Handler, or a Server Component — never a Client Component): read the
  `slate_session` cookie, `verify` it with `createSessionCodec`, return
  `undefined` for anything unverifiable (malformed, wrong key, expired).
- On success load fresh per request: user row, membership rows, permission set.
  No cross-request permission cache (ADR 002, Section 65).
- Cross the boundary as props only: user, tenants, activeTenantId, permissions,
  requestId. Cookie value, secret, codec, DB handle never leave the server zone
  (ESLint rule plus loud import guard plus test).
- Tenant precedence follows tenant-context: verified payload tenantId wins; a
  header or query naming another tenant is rejected (403), never re-scoped.
  Payload without tenantId: single membership binds, multiple requires explicit
  switch, none yields signed-in-but-tenardless state.
- Request-id correlation continues (Section 61): never log tenant data, session
  values, or tokens.

### 2. Navigation layout: one shell, two skins

- App Router layouts (`apps/*/src/app/**/layout.tsx`): sidebar, topbar (tenant
  switcher, theme toggle, profile entry, request-id affordance), main region.
  Shared pure-presentation pieces may live in `@slate/ui`; session reads stay in
  the app server zone and pass down as props.
- Nav entries declare a required permission key; the server layout filters with
  `hasPermission` per request, and direct fetches re-check.
- Axe-clean, keyboard-operable, server-resolved theme (no flash), AA tokens,
  tenant text as text, app-boundary CSP stays.

### 3. Tenant switcher: explicit, server-verified, audited

- Options come only from server-resolved membership rows, never client input.
- Switch is a server action (`POST { tenantId }`): re-read membership, refuse
  non-members (403), else re-issue the session and `Set-Cookie` with the same
  attributes (`HttpOnly`, `SameSite=Lax`, `Secure`, `Path=/`, `Max-Age=TTL`).
  Client never writes, signs, or parses the cookie.
- Each switch leaves exactly one attributable audit row (actor, prev/new
  tenant, request id); transitions render no rival-tenant payload.

### 4. Profile tray: identity display plus safe sign-out

- Shows server-resolved identity (name/email, active tenant/org) plus sign-out.
  Never renders permission keys as client capabilities.
- Sign-out is server-side: answer `clearCookie()` and redirect; client does not
  manipulate the cookie directly.
- Web storage holds no authority: no session, permissions, or tenant bindings
  in `localStorage` or `sessionStorage` (theme preference only, by design).

### 5. Route guards: fail closed, server-side, two layers

- Layer 1 (layout): `requireSession()` before render. No session redirects to
  the signed-out surface (401 for API-shaped); wrong-tenant binding is 403,
  never re-scoped; missing route permission is 404-or-403 per app policy.
  Public routes enumerated; default is protected.
- Layer 2 (data): every read or mutation goes through `/api/v1` handler checks
  (authenticate plus tenant-context plus permissions). Shell surfaces the typed
  error union; it adds no second authority.
- Client-side hiding is UX only: direct calls with the same cookie fail the
  same checks (adversarial test).

## Alternatives considered

| Option                                                            | Risk                                   | Decision               |
| ----------------------------------------------------------------- | -------------------------------------- | ---------------------- |
| Client-held session in storage, tenant in a store                 | Forgery, XSS, stale grants (Sec 13/65) | Rejected               |
| Middleware-only guard, no layout re-check                         | No fresh DB permission reads           | Rejected as sole guard |
| Permission list cached in session payload                         | Stale grants until re-issue            | Rejected               |
| Per-app bespoke shells, no shared skeleton                        | Two auth models, doubled audit         | Rejected               |
| Server-hydrated session plus audited switch plus two-layer guards | More server renders, stricter build    | Accepted               |

## Consequences and out of scope

- Positive: one auth model on both entry points; switching is explicit, audited,
  server-verified; guards fail closed when the client is bypassed; ADR 008
  invariants (a11y, theme, CSP) extend without re-decision.
- Costs: fresh user/membership/permission reads per protected render; layouts
  must handle expired, revoked, tenardless states; more tests and build surface.
- Deferred: command search and notification centre beyond placeholders, dashboard
  and portal content (SLATE-302), Playwright E2E (SLATE-303), theme/template
  runtime (Sec 15), plugin UI (Sec 16/17), i18n, vertical modules (Sec 37-44).
- Not decided here: sign-in/registration/MFA/recovery screens, rotation or
  revocation lists beyond TTL plus per-request re-read, device management.

## Acceptance and validation

SLATE-301 proves with tests: server hydration from a real signed session (no
fixtures), switch refusal for non-members, unauthenticated redirect
server-side, permission-filtered nav that stays refused on direct fetch,
audited switch with one attributable row, no sensitive value in web storage,
shell rendering from real tenant data in both apps. Phase-gate cells
(API/Permission/Tenant/Audit/Events/Tests) covered; `npm run verify` passes.
