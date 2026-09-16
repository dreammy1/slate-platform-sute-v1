-- =============================================================================
-- 0002 - Phase 2 core tables: app_user (SLATE-200)
-- =============================================================================
-- A human principal. Global across tenants on purpose: a user joins any number
-- of tenants through tenant_membership (0004), so `app_user` deliberately has
-- no tenant_id column and is never reachable through the scoped helper.
--
-- password_hash is a stub (empty string default) until SLATE-202's security
-- ADR owns the hashing scheme; email uniqueness is case-insensitive.
-- =============================================================================

CREATE TABLE IF NOT EXISTS app_user (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL DEFAULT '',
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_key ON app_user (lower(email));
