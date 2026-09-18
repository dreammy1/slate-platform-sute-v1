-- =============================================================================
-- 0009 - Search documents (SLATE-208, ADR 007)
-- =============================================================================
-- Backs `@slate/search`. ADR 007 selects PostgreSQL full-text search over an
-- external engine for Phase 2: the tenant predicate sits in the same WHERE
-- clause as the match, so isolation is a property of the query rather than of a
-- second service's configuration, and no new service has to be operated.
--
-- `search_vector` is a *stored generated* column. The index can therefore never
-- drift from the row, and neither application code nor a client can supply a
-- vector of its own. The expression is immutable - `to_tsvector` with an
-- explicit `'english'` configuration, which is what Postgres requires of a
-- generated column (the single-argument form is only STABLE).
--
-- `record_id` is the id of the row this document describes; it is a uuid like
-- every other platform id, and it is unique per (tenant, entity) so indexing the
-- same record twice replaces its text instead of duplicating it.
-- =============================================================================

CREATE TABLE IF NOT EXISTS search_document (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    entity text NOT NULL CHECK (length(entity) BETWEEN 1 AND 64),
    record_id uuid NOT NULL,
    title text NOT NULL CHECK (length(title) <= 255),
    body text NOT NULL CHECK (length(body) <= 20000),
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uk_search_document_record UNIQUE (tenant_id, entity, record_id)
);
--> statement-breakpoint

-- The GIN index is what makes `@@ plainto_tsquery` a lookup instead of a scan.
CREATE INDEX IF NOT EXISTS idx_search_document_vector ON search_document USING GIN (search_vector);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_search_document_tenant_entity ON search_document (tenant_id, entity);
