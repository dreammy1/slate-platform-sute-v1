-- =============================================================================
-- 0004 - Phase 2 core tables: tenant_membership and audit_log (SLATE-200)
-- =============================================================================
-- tenant_membership links a global app_user into exactly one tenant,
-- optionally holding a tenant-scoped role (ON DELETE SET NULL: revoking a
-- role never deletes the membership). Uniqueness (tenant_id, app_user_id)
-- keeps one membership row per user per tenant.
--
-- audit_log is the immutable trail later phases write to before a mutation's
-- response returns (SLATE-203): always tenant-attributed, optional actor
-- (system actions), payload jsonb. actor_user_id ON DELETE SET NULL keeps the
-- trail even after a user is removed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_membership (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    app_user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    role_id uuid REFERENCES role (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS tenant_membership_tenant_user_key
    ON tenant_membership (tenant_id, app_user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS tenant_membership_app_user_id_idx ON tenant_membership (app_user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
    action text NOT NULL,
    resource_type text NOT NULL DEFAULT '',
    resource_id text NOT NULL DEFAULT '',
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS audit_log_tenant_occurred_at_idx
    ON audit_log (tenant_id, occurred_at DESC);
