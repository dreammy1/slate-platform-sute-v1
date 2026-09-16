# Current Status

- Current Phase: Phase 2 (Slate Core)
- Last Completed Task: Executed **SLATE-202** (user + role + permission model &
  authorization, `agent:backend` + `agent:security`) per
  `docs/phase2-agent-tasks.md`, on top of SLATE-201. Created the
  `packages/auth` workspace (`@slate/auth`) plus
  `docs/adr/002-authentication-and-authorization.md` (Accepted):
  `src/user.ts` (authentication anchor — `getCurrentUser(db, userId)`
  resolving the `app_user` row by **server-derived** id (Section 13), `null`
  for unknown/inactive users; injectable `AuthQueryService` (getCurrentUser /
  getPermissionsForUser / findPermission) as the unit-test seam;
  `AuthAuthenticationError` with `AUTH_NOT_FOUND` / `AUTH_UNAUTHORIZED` /
  `AUTH_REVOKED` codes), `src/permissions/evaluator.ts` (the stateless
  authorization spine — `getPermissionsForUser` returning the distinct sorted
  permission set, `hasPermission` answering `false` (never throwing) for
  unknown/foreign keys, `assertPermission` failing closed with
  `PermissionAuthorizationError`, optional ownership input unioned on top),
  `src/permissions/query-service.ts` (the Kysely join chain
  `tenant_membership ⨝ role_permission ⨝ permission` pinning **both**
  `tenant_membership.tenant_id` and `permission.tenant_id` to the requested
  tenant, so cross-tenant leakage is structurally impossible),
  `src/permissions/ownership.ts` (domain-implemented `OwnershipPolicy`
  granting extra owner-level keys; `[]` when absent, never `null`),
  `src/permissions/errors.ts` (`PermissionNotFoundError`,
  `PermissionAuthorizationError` with a message that does not enumerate the
  permission space), `src/types.ts` (domain records + Kysely-row parsers) and
  `src/env.ts` (`SLATE_AUTH_PEPPER` stub readers; real hashing stays deferred
  to the security ADR). The evaluator **never caches** (Section 65): every
  call re-queries. Tests: 19 unit (hermetic evaluator matrix incl. the
  tenant-isolation and mid-session-revocation cases via fakes, ownership
  union, Section 13 id rejection) + 5 integration in isolated schemas via
  `@slate/testing/postgres`: tenant A's keys invisible from tenant B,
  `getCurrentUser` active/inactive/unknown, `createAuth` wiring (incl.
  ownership) and a **live committed revocation** observed on the very next
  `hasPermission` call. Repo-wide: 189 unit + 24 integration tests green.
- Next Task: Execute **SLATE-203** (tenant-aware API scaffold, audit logging &
  event bus, `agent:backend` + `agent:qa`): the request handler that wires
  tenant context (SLATE-201) and authz (SLATE-202) together, one `audit_log`
  row per mutation inside the request transaction, and the in-process event
  bus (`app.user.created`, `app.audit.recorded`). Gate in-flight:
  **API → Audit → Tests**, completing the Phase 2 Section 31 chain
  **Organization → User → Permission → Tenant record → API → Audit → Tests**.
- Validation: `npm run verify` passes end to end — `format:check` (Prettier
  clean incl. the new package), `lint` (0 errors), `typecheck` (0 errors),
  `test:unit` (189 passed: 19 `@slate/auth` + 48 `@slate/database` +
  80 `@slate/observability` + 19 `@slate/tenant-context` + 23
  `@slate/testing`), `test:integration` (24 passed against the live
  `slate-postgres` container via `TEST_DATABASE_URL`: 5 `@slate/auth` +
  6 `@slate/database` + 8 `@slate/tenant-context` + 5 `@slate/testing`),
  `build` (0 errors).
- Blockers: None. Commits are local on `main` (ahead of `origin/main`); not
  yet pushed, so the first green CI run on GitHub following the
  dependabot/lockfile fix is still pending.
