# ADR 007 – Search Abstraction & System Health Checks

## Status

**Accepted** – 2026-09-18. Implementation is SLATE-208
(`docs/phase2-agent-tasks.md`).

## Context

The platform must expose two orthogonal but related capabilities:

1. **Search abstraction** – allow tenants to index and query their own data
   without leaking across tenant boundaries. Two plausible implementations are:
   - **PostgreSQL full‑text search + pg_trgm** – leverages the existing `pg`
     database, stays in‑process, and respects tenant `tenant_id` filtering via
     standard SQL WHERE clauses. Simple to prototype, supports ranking, and works
     with the existing migration framework.
   - **External search engine** (e.g. **MeiliSearch**, **Elastic**, **Typesense**)
     – dedicated search service, provides richer relevance tuning, typo
     tolerance, and can be hosted per‑tenant or multi‑tenant with strict
     isolation. Requires an additional service and a connector layer.

2. **System health checks** – standard Kubernetes‑style probes:
   - `GET /health/live` – confirms the process is alive (no DB lookup).
   - `GET /health/ready` – confirms the service can talk to all required
     subsystems (DB, optional search engine, event bus). Returns 200 only when
     every component reports healthy.

Both capabilities must be **tenant‑isolated** where applicable, must emit
audit events (`search.indexed`, `search.query`) and must be covered by unit and
integration tests.

## Decision

- Adopt **PostgreSQL full‑text search + pg_trgm** as the default implementation
  for Phase 2. It avoids external dependencies, fits the existing Kysely
  workflow, and satisfies the immediate need for searchable tenant data.
- Define an **abstraction interface** (`SearchEngine`) in `@slate/search` that
  can later be swapped for an external provider without touching core API
  routes.
- Implement **health check routes** in `@slate/api` under `/health/live` and
  `/health/ready`. The ready probe checks the DB connection and, when the
  optional external engine is configured, pings its health endpoint.
- Emit audit events `search.indexed` (metadata only: `tenantId`, `entity`,
  `recordId`) and `search.query` (metadata only: `tenantId`, `query`).

## Consequences

- All searchable tables must include a `tenant_id` column (already enforced by
  the `TENANT_OWNED_TABLES` list). Indexes will be created on
  `to_tsvector(...)` expressions scoped to each tenant.
- Future work can replace the PG backend with an external engine by providing a
  new `SearchEngine` implementation that satisfies the same contract.
- Health checks become part of the CI health‑check suite and can be used by
  orchestration platforms for zero‑downtime rollouts.

---

## Implementation Sketch (for reference)

```ts
export interface SearchEngine {
  index(tenantId: string, entity: string, id: string, document: string): Promise<void>;
  query(tenantId: string, entity: string, q: string, limit?: number): Promise<SearchResult[]>;
}
```

- `@slate/search` will provide a `PostgresSearchEngine` implementation that
  generates/updates a `tsvector` column and runs `@@ plainto_tsquery(q)`.
- API routes `POST /search/:entity` (index) and `GET /search/:entity?q=` (query)
  will be added under SLATE‑208 contract.
- Health routes live in `packages/api/src/health.ts` and are wired in the
  `createHttpHandler`.
