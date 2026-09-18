# 004 — Background Jobs & Task Queue

- **Status:** Accepted
- **Date:** 2026-09-17
- **Deciders:** Slate architecture, security review
- **Tags:** jobs, PostgreSQL, tenancy, reliability, observability, Phase 2
- **Master Plan refs:** Sections 10, 13, 15, 31, 57, 61, 64, 65, 67, 68; ADR 001; SLATE-205 in `docs/phase2-agent-tasks.md`

## Context and sequencing

SLATE-200 through SLATE-204 provide PostgreSQL/Kysely, tenant context, permissions,
audit logging and configuration. Remaining core capabilities include jobs,
notifications, media, search abstraction and health checks. Select **jobs first**:
notifications and media processing need durable asynchronous execution, retry
handling and failure visibility. Building those first on the existing in-process
bus would risk losing work after the originating transaction commits.

The SLATE-203 bus is explicitly best-effort. It cannot be the durable enqueue
mechanism. Section 61 requires failed-job and queue-depth monitoring. SaaS and
self-hosted deployments should not require another service for this bounded
first implementation.

## Architectural choices

| Option                                              | TypeScript and integration                                                                      | Reliability and operating cost                                                                                     | Decision                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| In-process timers/event subscribers                 | Existing typed bus, easy integration                                                            | Lost work on restart; cannot atomically persist work with domain writes                                            | Reject for durable work          |
| Redis-backed queue (for example BullMQ)             | Typed library, but serialized payloads still require runtime validation                         | Mature worker features; new service and dependency; database-to-broker dual-write requires an outbox               | Defer                            |
| PostgreSQL queue library (for example pg-boss)      | TypeScript-facing API; library-specific schema and transaction adapters need assessment         | Reuses PostgreSQL with mature scheduling; must verify compatibility with Kysely transactions and tenant boundaries | Defer; reconsider if scope grows |
| Small PostgreSQL queue through existing Kysely/`pg` | Existing strict TypeScript stack and migration runner; same transaction object as domain writes | No extra service; we own leases, retries and concurrency tests                                                     | **Propose for SLATE-205**        |

No new queue library is selected or installed by this planning change. The
library alternatives are architectural candidates, not verified compatibility
claims. Revisit this decision before cron, workflows or high-throughput broker
requirements expand the custom implementation.

## Proposed decision

### Typed, code-owned jobs

Create `packages/jobs` (`@slate/jobs`). A generic code-owned registry associates
versioned dotted names with `parse(input: unknown): Payload` and an async handler.
Enqueue is typed by registry key and inferred payload; persisted JSON is always
parsed again before execution. Use strict TypeScript, discriminated job states,
readonly contexts and the existing shared tsconfig/Vitest presets. No `any`,
dynamic imports, executable payloads or user-supplied handler names. Payloads
are bounded JSON containing identifiers, not credentials or message bodies.
Unknown job types or invalid persisted payloads become terminal failures without
executing a handler. Existing job versions remain registered while rows exist.

### Transactional persistence

Migration `0006_background_jobs.sql` creates tenant-owned `background_job`:

- `id uuid` primary key; `tenant_id uuid NOT NULL` referencing tenant;
- `type text`, `payload jsonb`, `idempotency_key text`, all NOT NULL;
- `status text` constrained to `pending | running | succeeded | failed`;
- `attempts integer` initially zero and nonnegative; `max_attempts integer`
  bounded to 1–10 (default 3), fixed from server configuration at enqueue;
- `available_at`, `created_at`, `updated_at` non-null timestamptz;
- nullable `lease_token uuid`, `lease_expires_at`, `finished_at`,
  `actor_user_id uuid` (FK to app_user, ON DELETE SET NULL), `request_id text`,
  and `last_error_code text` (allowlisted code, never arbitrary exception text).

Require unique `(tenant_id, type, idempotency_key)`, an index on
`(tenant_id, status, available_at, id)` and an expired-lease lookup index.
A CHECK ties non-null lease fields to `running`; terminal rows have `finished_at`.
Register the table in `Database` and `TENANT_OWNED_TABLES`.

`enqueue(trx, context, input)` requires an existing Kysely transaction. The domain
write, new job and one `jobs.enqueued` audit row commit together; audit failure
rolls everything back. Duplicate keys return the original job without a second
audit; a different payload under the same key is a conflict. Deduplication lasts
while the row exists; cleanup is not in this milestone. Producer authorization
is the calling domain service's responsibility and must occur before enqueue.
A best-effort event is not used to insert the durable job after commit.

### Tenant-bound workers and delivery semantics

A host explicitly starts a worker for one validated tenant, using a trusted
server-side tenant assignment, not an HTTP header or a tenant id in a payload.
No global cross-tenant dispatcher or tenant discovery is introduced. Claims,
reads, retries and acknowledgements all use `createTenantDatabase` with that
scope; handlers receive the scoped database, job id, attempt, logger and abort
signal, never the root client. This is an application boundary, not PostgreSQL
RLS or a sandbox for untrusted handlers.

Claim one due row atomically inside a short transaction with
`FOR UPDATE SKIP LOCKED`, ordering by `available_at, id`. Increment attempts,
set a fresh lease token and expiry using database time, and commit before running
the handler. No transaction or row lock is held during handler execution.
Completion, renewal and failure updates require tenant id, job id, running state,
matching lease token and an unexpired lease; stale workers cannot acknowledge
or overwrite a newer attempt. Lease recovery also covers the final exhausted
attempt, transitioning it to failed rather than leaving it permanently running.

Delivery is **at least once**, never exactly once. A crash after an external side
effect but before acknowledgement can cause redelivery. Handlers must use the
stable job id as a downstream idempotency key or perform database effects and
an idempotency check in one transaction. Lease fencing protects queue state,
not external side effects. Handlers reload referenced records within their tenant
and reauthorize any deferred user-privileged action; the stored actor is audit
attribution, not a permanent permission grant.

Retry transient failures with capped exponential backoff (1 second base,
60 second cap) and injected jitter; non-retryable validation/authorization
failures go straight to `failed`. Use bounded worker concurrency (default 1,
maximum 10 per worker), 60 second leases renewed every 20 seconds, and a
5 minute handler timeout. These server settings are validated at startup.
Shutdown stops claiming, signals cancellation and waits a bounded grace period;
unacknowledged work is recovered after lease expiry. No timer starts on import.
A lost lease or timeout aborts the handler signal; cancellation is cooperative,
so handlers must still be idempotent. A failed terminal job requires a new
producer command/idempotency key for another execution; no manual retry API yet.

### API, events and observability

Expose read-only `GET /jobs` and `GET /jobs/:id` through the current API chain,
requiring live tenant-scoped `jobs.read`. List uses `limit` (default 50, maximum
100), optional validated status and an opaque `(created_at, id)` cursor. Cursors
never determine tenant scope. Responses include lifecycle metadata only; omit
payload, idempotency key, lease token and raw error details. A foreign or missing
id returns the same 404. No arbitrary-job submission, cancellation or worker
control endpoint is exposed. A test-only registered handler proves the queue
without inventing a production notification/media capability.

Inject a typed lifecycle publisher into `@slate/jobs` rather than depending on
`@slate/api`. The host bridges `jobs.enqueued`, `jobs.succeeded`, `jobs.failed`
and `jobs.retry_scheduled` to the existing bus. Payloads contain only
`{ tenantId, jobId, type, attempt }`. Publish after the corresponding transaction
commits; enqueue's caller receives a notification descriptor to publish only
once its outer transaction succeeds. Publisher failures cannot reverse committed
state; these events remain best-effort, not a durable event outbox.

Reuse `@slate/observability` child loggers with tenantId, jobId, type, attempt
and requestId. Record claim/finish duration, retry and safe error codes. Expose
`getQueueStats(tenantId)` with due, delayed, running and failed counts plus oldest
due age; expose an injectable typed observer for durations/outcomes without
adding a metrics backend. Never use payloads or tenant ids as unbounded metric
labels. Log/observer failures must not change delivery state.

Do not rely on heuristic redaction of JSON strings: enqueue parameters can
otherwise leak through the existing SQL query logger. Add a tested opt-in
parameter-omission mode to the database logger for queue connections and
producer transactions, including error logging. Require it when queue payloads
are persisted; keep unrelated query logging unchanged. Neither worker errors,
SQL parameters, lifecycle events nor read APIs may expose payload content.

## Consequences and out of scope

- Positive: atomic domain-write/enqueue/audit, no extra service, tenant-bound
  workers and shared TypeScript/testing/observability conventions.
- Costs: PostgreSQL polling and table growth; custom lease/retry correctness
  requires independent-worker integration tests. This is not a general workflow
  engine, a fairness guarantee across tenants, or an exactly-once executor.
- Deferred: Redis/broker adoption, cron, workflows, priorities, global dispatch,
  production process orchestration, retention/purge, queue UI, notification
  transports/templates, media processing and durable event-bus delivery.
- No implementation starts until this ADR is accepted. Phase 2 remains open.

## Acceptance and validation

The SLATE-205 contract is the implementation checklist. It must prove atomic
rollback, concurrent claim exclusion, restart recovery, stale-token rejection,
retry exhaustion, deduplication, tenant isolation, live permission revocation,
post-commit events and payload omission in all sinks. Use real isolated
PostgreSQL schemas and independent connections via `@slate/testing`; use injected
clocks/sleep/random sources in unit tests rather than timing-dependent sleeps.
Migration tests cover clean install, upgrade from 0005 and rerun idempotency.
`npm run verify` must pass, and API/DB/Permission/Tenant/Events/Tests/Docs cells
must be covered before SLATE-205 implementation is marked complete.
