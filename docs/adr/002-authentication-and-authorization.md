# 002 — Authentication & Authorization

- **Status:** Accepted
- **Date:** 2026-09-16
- **Deciders:** Slate architecture, security review
- **Tags:** authentication, authorization, RBAC, security, Phase 2
- **Master Plan refs:** Section 13 (never trust client-provided IDs), Section 65 (adversarial cases — stale grants), Section 14 (core domain model), docs/phase2-agent-tasks.md (SLATE-202)

## Context

Phase 2 (Slate Core) needs an **authentication anchor** and an **authorization spine**. Every API route must be able to:

1. Resolve the current user from the authenticated principal (`getCurrentUser`).
2. Check whether that user holds a permission in a tenant (`hasPermission`).

The database already has the core tables from SLATE-200: `app_user`, `role`, `permission`, `role_permission`, `tenant_membership`. This ADR defines how those tables are used for authn/authz, what is explicitly out of scope (external identity providers, OAuth, password hashing specifics), and the security invariants that must hold.

## Decision

### Authentication (authn)

- `getCurrentUser(db, userId): Promise<AuthUser | null>` — fetches the `app_user` row by server-derived ID. Returns `null` when the user does not exist or is inactive.
- User IDs are **server-derived** (Master Plan Section 13): never accepted from a client header alone. The principal (`AuthenticatedPrincipal.userId` from `@slate/tenant-context`) is the only source of user identity.
- Password hashing is **stubbed** (`password_hash text NOT NULL DEFAULT ''` in the migration). Real hashing (bcrypt/argon2) is deferred to a security ADR and is **not** part of SLATE-202.

### Authorization (authz)

- `hasPermission(user, tenantId, permission): Promise<boolean>` — checks whether a user holds a permission key in a tenant.
- `getPermissionsForUser(db, userId, tenantId): Promise<readonly string[]>` — returns the full set of permission keys for a user in a tenant (via `tenant_membership → role → role_permission → permission`).
- Permissions are **tenant-scoped**: a permission row belongs to a tenant (`permission.tenant_id`), and a user's permission set is computed within a single tenant. A user in tenant A cannot see or use tenant B's permissions.
- The evaluator **never caches** permission sets. Every call re-queries the database, so a role's permission revoked mid-session is immediately reflected (Master Plan Section 65).

### Object ownership

- Domain layers may provide an `OwnershipPolicy` that grants additional permissions to the owner of a resource.
- The evaluator accepts an optional ownership policy; when present and the user owns the resource, owner-level permissions are granted in addition to role-based permissions.
- Ownership is resource-type-specific and implemented by domain layers, not by the auth package.

### Authorization flow (gate in-flight: Organization → User → Permission)

Every API route consults:

1. **Organization** — resolved from the tenant context (SLATE-201).
2. **User** — resolved from the authenticated principal via `getCurrentUser`.
3. **Permission** — checked via `hasPermission` before executing the operation.

## Security requirements

### Section 13 — server-derived IDs

User IDs, tenant IDs, and permission IDs are never accepted from client input alone. They come from the session principal (`AuthenticatedPrincipal`) or from database lookups using server-derived values.

### Section 65 — no stale grants

The permission evaluator must not cache permission sets. A user whose role is revoked mid-session must not retain access through a stale grant. Every `hasPermission` call re-queries the database.

Implementation: the evaluator queries `tenant_membership → role → role_permission → permission` on every call. No in-memory cache, no session-level permission set.

### Tenant isolation

A user's permission set is computed within a single tenant. The evaluator joins through `tenant_membership.tenant_id = $tenantId` and `permission.tenant_id = $tenantId`, so cross-tenant permission leakage is structurally impossible.

## Out of scope

- External identity providers (OAuth, SAML, OIDC) — deferred to a later phase.
- RBAC UI — management of roles/permissions is a Phase 4 concern.
- Feature flags (SLATE-204).
- Password hashing specifics — deferred to a security ADR; the `password_hash` column is a stub.

## Acceptance criteria

- A tenant's users cannot see another tenant's permissions in their set (tenant isolation).
- Revoking a role's permission removes it from `hasPermission` immediately (Section 65, no stale grants).
- Unit suite covers the evaluator with fakes; integration suite runs in an isolated schema via `@slate/testing/postgres`.
