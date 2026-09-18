-- =============================================================================
-- 0008 - Media Files (SLATE-207)
-- =============================================================================
-- Tracks metadata for binary assets stored via the MediaStorageProvider.
-- The physical storage path is tenant-bound to ensure isolation.
-- =============================================================================

CREATE TABLE IF NOT EXISTS media_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    storage_path text NOT NULL,
    mime_type text NOT NULL CHECK (length(mime_type) <= 128),
    size bigint NOT NULL CHECK (size >= 0),
    original_name text NOT NULL CHECK (length(original_name) <= 255),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uk_media_files_path UNIQUE (tenant_id, storage_path)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_media_files_tenant_id ON media_files(tenant_id);
CREATE INDEX IF NOT EXISTS idx_media_files_created_at ON media_files(tenant_id, created_at);
