-- =============================================================================
-- 0007 - Notification Delivery Logs (SLATE-206)
-- =============================================================================
-- While the request to notify is captured in `audit_log` at enqueue time,
-- the actual delivery outcome (provider message ID, success/failure) is
-- recorded here when the background job executes.
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_delivery_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    job_id uuid NOT NULL, -- Link to the background_job that performed the delivery
    recipient text NOT NULL,
    type text NOT NULL, -- 'email' or 'sms'
    provider_message_id text,
    status text NOT NULL, -- 'delivered', 'failed'
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_tenant ON notification_delivery_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_job ON notification_delivery_log (job_id);
