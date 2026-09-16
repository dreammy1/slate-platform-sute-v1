-- =============================================================================
-- 0003 - Phase 2 core tables: role, permission, role_permission (SLATE-200)
-- =============================================================================
-- The authorization spine. Roles and permissions are tenant-scoped on purpose
-- (docs/phase2-agent-tasks.md, SLATE-202: "a permission is only valid in its
-- tenant") - a tenant's roles can never grant into another tenant's tables,
-- and the composite unique keys keep names/keys unique per tenant.
-- =============================================================================

CREATE TABLE IF NOT EXISTS role (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS role_tenant_name_key ON role (tenant_id, name);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS permission (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    key text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS permission_tenant_key_key ON permission (tenant_id, key);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS role_permission (
    role_id uuid NOT NULL REFERENCES role (id) ON DELETE CASCADE,
    permission_id uuid NOT NULL REFERENCES permission (id) ON DELETE CASCADE,
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (role_id, permission_id)
);
