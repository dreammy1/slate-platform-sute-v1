-- =============================================================================
-- 0001 - Phase 2 core tables: organization and tenant (SLATE-200)
-- =============================================================================
-- Dependency order: organization -> tenant -> app_user -> role/permission ->
-- tenant_membership -> audit_log. Statements are separated on their own line
-- by the statement-breakpoint marker so the runner executes each one
-- individually over the pg extended protocol.
--
-- Conventions mirrored from infrastructure/postgres/init/: plain, reviewable
-- SQL; uuid primary keys from gen_random_uuid() (core since PostgreSQL 13);
-- timestamptz everywhere; ON DELETE CASCADE from parent to owned rows.
--
-- The organization is the root entity (billing/legal identity) and never
-- carries a tenant_id. Tenant rows are owned by exactly one organization.
-- =============================================================================

CREATE TABLE IF NOT EXISTS organization (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS organization_slug_key ON organization (slug);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS tenant (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS tenant_slug_key ON tenant (slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS tenant_organization_id_idx ON tenant (organization_id);
