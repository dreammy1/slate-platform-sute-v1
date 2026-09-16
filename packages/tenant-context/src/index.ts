/**
 * `@slate/tenant-context` - the request-scoped tenant context layer (SLATE-201).
 *
 * Three concerns, in the order a request needs them:
 *
 * 1. **Resolution** ({@link resolveTenantContext}) - the tenant comes from the
 *    authenticated principal or, only when the session authorizes it, from
 *    the `X-Tenant-Id` header. Rejections (401/403) happen here, before any
 *    database query is issued.
 * 2. **Scoping** ({@link createRequestDatabase}, {@link tenantDatabaseFor}) -
 *    the resolved tenant is injected into `createTenantDatabase(db, tenantId)`
 *    from `@slate/database`, and the request's `search_path` is pinned so
 *    unqualified queries cannot escape their schema.
 * 3. **Ownership and events** ({@link resolveTenantOrganization},
 *    {@link emitTenantSelected}) - the owning organization row is resolved and
 *    `tenant.selected` is emitted with `{ tenantId, organizationId }`.
 *
 * Master Plan reference: Section 13 (never trust client-provided ids),
 * Section 65 (adversarial cases), docs/phase2-agent-tasks.md (SLATE-201).
 */

export * from './context.ts';
export * from './database.ts';
export * from './events.ts';
export * from './organization.ts';
export * from './principal.ts';
