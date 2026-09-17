-- =============================================================================
-- 0005 - Phase 2 core tables: system_setting and feature_flag (SLATE-204)
-- =============================================================================
-- The tenant-scoped configuration store
-- (docs/adr/003-system-settings-and-feature-flags.md).
--
-- Both tables carry `tenant_id NOT NULL` and are registered in
-- TENANT_OWNED_TABLES, so every read and write goes through the SLATE-200
-- scoped helper `db(tenantId)`: a query that would cross the tenant boundary is
-- not expressible by accident.
--
-- system_setting holds tenant-owned configuration data. `value` is jsonb stored
-- together with an explicit `value_type` discriminator, so a value round-trips
-- with the type it was written with instead of a stringified approximation.
--
-- feature_flag holds per-tenant OVERRIDES only. Flag definitions and their
-- defaults live in code (@slate/settings), so adding a flag needs no migration
-- and a key nobody declared can never be switched on (Section 60).
-- =============================================================================

CREATE TABLE IF NOT EXISTS system_setting (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    key text NOT NULL,
    value_type text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS system_setting_tenant_key_key
    ON system_setting (tenant_id, key);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS feature_flag (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    key text NOT NULL,
    enabled boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS feature_flag_tenant_key_key
    ON feature_flag (tenant_id, key);
