-- =============================================================================
-- 0006 - Phase 2 core tables: background_job (SLATE-205)
-- =============================================================================
-- The durable task queue (docs/adr/004-background-jobs-and-task-queue.md).
--
-- tenant_id is mandatory and the table is registered in TENANT_OWNED_TABLES, so
-- every read and write goes through the SLATE-200 scoped helper `db(tenantId)`;
-- a job that crosses the tenant boundary is not expressible at the call site.
--
-- Job payloads are opaque `jsonb` to the database: `@slate/jobs` owns parsing,
-- validation and the 16 KiB bound, so nothing here trusts payload content.
-- Lifecycle columns are constrained so an invalid state (a running row without
-- a lease, a terminal row without `finished_at`) cannot be persisted.
-- =============================================================================

CREATE TABLE IF NOT EXISTS background_job (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    type text NOT NULL CHECK (length(type) <= 128),
    payload jsonb NOT NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) <= 128),
    status text NOT NULL
        CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    lease_expires_at timestamptz,
    actor_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
    request_id text,
    last_error_code text
        CHECK (last_error_code IN
            ('handler_error', 'payload_invalid', 'unknown_type', 'handler_timeout', 'lease_lost')),
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- A running row always carries a live lease token; any other status has none.
    CONSTRAINT background_job_running_has_lease CHECK (
        (status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    -- A terminal row is finished; a non-terminal row is not.
    CONSTRAINT background_job_terminal_finished CHECK (
        (status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)
    )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS background_job_tenant_type_idempotency_key_key
    ON background_job (tenant_id, type, idempotency_key);
--> statement-breakpoint

-- Claim ordering: due work first, oldest available before newest.
CREATE INDEX IF NOT EXISTS background_job_claim_idx
    ON background_job (tenant_id, status, available_at, id);