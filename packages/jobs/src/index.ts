/**
 * `@slate/jobs` — the durable PostgreSQL-backed task queue (SLATE-204, ADR 004).
 *
 * Exports, in the order an application needs them:
 *
 * 1. **The registry** (`createJobRegistry`) — the code-owned job surface.
 * 2. **Transactional enqueue** (`enqueue`) — call inside the domain transaction.
 * 3. **The tenant-bound worker** (`createWorker`) — claim, lease, retry, recover.
 * 4. **Read-only inspection** (`listJobs` / `getJob`) — summary allowlist only.
 *
 * Nothing here starts a timer on import: a worker is inert until `start()`.
 */

export * from './errors.ts';
export * from './registry.ts';
export * from './enqueue.ts';
export * from './worker.ts';
export * from './inspection.ts';
