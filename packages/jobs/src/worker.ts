/**
 * The tenant-bound job worker (ADR 004).
 *
 * A worker is created for **one** tenant: its host passes a server-derived
 * tenant id, and every claim, transition and recovery query goes through the
 * SLATE-200 scoped helper, so cross-tenant access is not expressible. Claiming
 * uses `FOR UPDATE SKIP LOCKED` in a short transaction (no lock is held while
 * a handler runs); every later transition is fenced by tenant + job id + running
 * status + lease token + unexpired lease, so a stale worker cannot acknowledge
 * or overwrite a newer attempt.
 *
 * Delivery is at-least-once: a crash between an external side effect and the
 * acknowledgement causes redelivery, and handlers must be idempotent. All
 * timing inputs (clock, sleep, jitter, lease tokens) are injectable so unit
 * tests are deterministic; integration tests drive recovery by persisting
 * expired leases directly rather than sleeping.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import { createTenantDatabase, type Database, type TenantScopedDatabase } from '@slate/database';
import type { Logger } from '@slate/observability';

import { JOB_ERROR_CODES, NonRetryableJobError, type JobErrorCode } from './errors.ts';
import type { JobEventName, JobEventPublisher } from './enqueue.ts';
import type { AnyJobDefinition, JobHandlerContext, JobRegistryMap } from './registry.ts';

/** Operational bounds; every value is validated before a worker starts. */
export interface WorkerConfig {
  /** Parallel handlers per worker (1–10). */
  readonly concurrency: number;
  /** Lease duration in seconds; renewed every {@link renewalSeconds}. */
  readonly leaseSeconds: number;
  /** Interval between lease renewals in seconds; must be < leaseSeconds. */
  readonly renewalSeconds: number;
  /** Handler timeout in seconds; aborts the context signal when exceeded. */
  readonly handlerTimeoutSeconds: number;
  /** Idle poll interval in milliseconds. */
  readonly pollIntervalMs: number;
  /** Retry backoff base and ceiling in milliseconds. */
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  /** How long shutdown waits for in-flight handlers before returning. */
  readonly shutdownGraceMs: number;
}

/** ADR 004 defaults. */
export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  concurrency: 1,
  leaseSeconds: 60,
  renewalSeconds: 20,
  handlerTimeoutSeconds: 300,
  pollIntervalMs: 1000,
  backoffBaseMs: 1000,
  backoffCapMs: 60_000,
  shutdownGraceMs: 10_000,
};

/** A live lease: token + expiry, created at claim time and fenced afterwards. */
export interface Lease {
  readonly token: string;
  readonly expiresAt: Date;
}

/** Queue statistics for one tenant (Section 61: queue depth, oldest due age). */
export interface QueueStats {
  readonly due: number;
  readonly delayed: number;
  readonly running: number;
  readonly failed: number;
  /** Age in seconds of the oldest due job, or `null` when nothing is due. */
  readonly oldestDueSeconds: number | null;
}

/** Injectable timing/identity sources; every default is production-safe. */
export interface WorkerOptions<M extends JobRegistryMap> {
  /** The one tenant this worker serves; server-derived, never from a header. */
  readonly tenantId: string;
  readonly db: Kysely<Database>;
  readonly registry: M;
  readonly logger: Logger;
  /** Optional event bridge; lifecycle events publish after commit. */
  readonly publisher?: JobEventPublisher | undefined;
  /** Config overrides; merged over {@link DEFAULT_WORKER_CONFIG} and validated. */
  readonly config?: Partial<WorkerConfig> | undefined;
  /** Injectable clock (UTC `Date`); defaults to the system clock. */
  readonly clock?: (() => Date) | undefined;
  /** Injectable sleep; defaults to a `setTimeout` promise. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Injectable jitter source in [0, 1); defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** Injectable lease-token generator; defaults to `crypto.randomUUID`. */
  readonly generateLeaseToken?: (() => string) | undefined;
}

/** Validates a merged worker config before the worker does anything. */
export function resolveWorkerConfig(overrides: Partial<WorkerConfig> | undefined): WorkerConfig {
  const config = { ...DEFAULT_WORKER_CONFIG, ...overrides };
  const integerIn = (value: number, min: number, max: number, name: string): number => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`[slate/jobs] worker config ${name} must be an integer in [${min}, ${max}].`);
    }
    return value;
  };
  integerIn(config.concurrency, 1, 10, 'concurrency');
  integerIn(config.leaseSeconds, 1, 3600, 'leaseSeconds');
  integerIn(config.renewalSeconds, 1, config.leaseSeconds, 'renewalSeconds');
  integerIn(config.handlerTimeoutSeconds, 1, 3600, 'handlerTimeoutSeconds');
  integerIn(config.pollIntervalMs, 1, 3_600_000, 'pollIntervalMs');
  integerIn(config.backoffBaseMs, 0, 3_600_000, 'backoffBaseMs');
  integerIn(config.backoffCapMs, config.backoffBaseMs, 86_400_000, 'backoffCapMs');
  integerIn(config.shutdownGraceMs, 0, 3_600_000, 'shutdownGraceMs');
  return config;
}

/** Capped exponential backoff with injected jitter: `min(cap, base*2^(n-1))` plus jitter. */
export function backoffDelay(
  attempt: number,
  config: Pick<WorkerConfig, 'backoffBaseMs' | 'backoffCapMs'>,
  random: () => number,
): number {
  const exponent = Math.max(0, attempt - 1);
  const exponential = Math.min(config.backoffCapMs, config.backoffBaseMs * 2 ** exponent);
  const jitter = Math.floor(random() * Math.min(exponential, config.backoffBaseMs));
  return Math.min(config.backoffCapMs, exponential + jitter);
}

/** The worker: start/stop lifecycle plus the deterministic `runOnce` used by tests. */
export interface JobWorker {
  /** Begins polling. No timer exists before this call (no import side effects). */
  start(): void;
  /** Stops claiming, waits the grace period for in-flight handlers. */
  stop(): Promise<void>;
  /** Claims and processes at most one job; resolves after it finishes. */
  runOnce(): Promise<void>;
  /** Current queue statistics for the worker's tenant. */
  getQueueStats(): Promise<QueueStats>;
}

/** The row shape a claim returns (the columns the runner needs). */
interface ClaimedJobRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly request_id: string | null;
  readonly lease_token: string;
  readonly lease_expires_at: Date;
}

/**
 * Builds the worker for one tenant.
 *
 * The returned object is inert until `start()` is called, so importing this
 * module never starts a timer (ADR 004).
 */
export function createWorker<M extends JobRegistryMap>(options: WorkerOptions<M>): JobWorker {
  const config = resolveWorkerConfig(options.config);
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const generateLeaseToken = options.generateLeaseToken ?? randomUUID;

  let running = false;
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  const scoped = (): TenantScopedDatabase => createTenantDatabase(options.db, options.tenantId);

  function log(message: string, context: Record<string, unknown>): void {
    try {
      options.logger
        .child({ tenantId: options.tenantId, component: 'jobs' })
        .info(message, context);
    } catch {
      /* a logging failure must never change delivery state */
    }
  }

  async function publishEvent(
    event: JobEventName,
    payload: {
      jobId: string;
      type: string;
      attempt: number;
    },
  ): Promise<void> {
    const publisher = options.publisher;
    if (publisher === undefined) return;
    try {
      await publisher.publish(event, {
        tenantId: options.tenantId,
        jobId: payload.jobId,
        type: payload.type,
        attempt: payload.attempt,
      });
    } catch {
      // Publisher failures never undo committed state (best-effort, ADR 004).
      log('jobs event publish failed', { event, jobId: payload.jobId });
    }
  }

  /**
   * Claims the oldest due, unexpired job: one short transaction that selects
   * with `FOR UPDATE SKIP LOCKED`, increments attempts and stamps a fresh
   * lease. Commits before the handler runs, so no lock is held during work.
   */
  async function claimOne(): Promise<ClaimedJobRow | undefined> {
    const now = clock();
    const leaseToken = generateLeaseToken();
    const expiresAt = new Date(now.getTime() + config.leaseSeconds * 1000);
    return options.db.transaction().execute(async (trx) => {
      const claimed = await sql<ClaimedJobRow>`
        select "id", "tenant_id", "type", "payload", "attempts", "max_attempts",
               "request_id", ${leaseToken}::uuid as "lease_token",
               ${expiresAt.toISOString()}::timestamptz as "lease_expires_at"
        from "background_job"
        where "tenant_id" = ${options.tenantId}
          and "status" = 'pending'
          and "available_at" <= ${now.toISOString()}::timestamptz
        order by "available_at" asc, "id" asc
        limit 1
        for update skip locked
      `.execute(trx);
      const row = claimed.rows[0];
      if (row === undefined) return undefined;
      await sql`
        update "background_job"
        set "status" = 'running', "attempts" = "attempts" + 1,
            "lease_token" = ${leaseToken}::uuid,
            "lease_expires_at" = ${expiresAt.toISOString()}::timestamptz,
            "updated_at" = now()
        where "id" = ${row.id} and "tenant_id" = ${options.tenantId}
      `.execute(trx);
      return row;
    });
  }

  /**
   * One fenced lifecycle transition. Every branch matches tenant + job id +
   * `running` status + lease token + unexpired lease, so a stale worker that
   * lost its lease can never acknowledge or overwrite a newer attempt.
   * Resolves `true` only when this worker's lease won the update.
   */
  async function transitionWhileLeased(
    jobId: string,
    lease: Lease,
    set: Record<string, unknown>,
  ): Promise<boolean> {
    const now = clock();
    const result = await scoped()
      .updateTable('background_job')
      .set({ ...set, updated_at: now } as never)
      .where('id', '=', jobId)
      .where('status', '=', 'running')
      .where('lease_token', '=', lease.token)
      .where('lease_expires_at', '>', now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  /** Renewal: extends the lease only while this worker still owns it. */
  async function renewLease(jobId: string, lease: Lease): Promise<boolean> {
    const now = clock();
    return transitionWhileLeased(jobId, lease, {
      lease_expires_at: new Date(now.getTime() + config.leaseSeconds * 1000),
    });
  }

  /** Runs one claimed job to a fenced terminal-or-retry outcome. */
  async function executeClaimed(claimed: ClaimedJobRow): Promise<void> {
    const { id: jobId, type, lease_token: token, lease_expires_at: expiresAt } = claimed;
    const lease: Lease = { token, expiresAt };
    const attempt = claimed.attempts + 1;
    const definition: AnyJobDefinition | undefined = options.registry[type];

    // A type the current registry does not declare fails terminally, without
    // a handler ever running (the registry owns the whole job surface).
    if (definition === undefined) {
      await failTerminal(jobId, lease, type, attempt, 'unknown_type');
      await publishEvent('jobs.failed', { jobId, type, attempt });
      return;
    }

    // Parse the persisted payload through the definition; an unparseable row
    // is a terminal `payload_invalid` failure — no handler is invoked.
    let payload: unknown;
    try {
      payload = definition.parse(claimed.payload);
    } catch {
      log('job payload failed validation', { jobId, type, attempt });
      await failTerminal(jobId, lease, type, attempt, 'payload_invalid');
      await publishEvent('jobs.failed', { jobId, type, attempt });
      return;
    }

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), config.handlerTimeoutSeconds * 1000);
    let renewing = true;
    // Cooperative renewal loop driven by the injected sleep, so tests can
    // exercise renewal deterministically instead of waiting real seconds.
    const renewalLoop = (async () => {
      while (renewing) {
        await sleep(config.renewalSeconds * 1000);
        if (!renewing) break;
        await renewLease(jobId, lease);
      }
    })();

    const handlerContext: JobHandlerContext<never> = {
      tenantId: options.tenantId,
      jobId,
      type,
      payload: payload as never,
      attempt,
      requestId: claimed.request_id ?? undefined,
      db: scoped(),
      logger: options.logger.child({
        tenantId: options.tenantId,
        jobId,
        type,
        attempt,
      }),
      signal: abort.signal,
    };

    try {
      await definition.handler(handlerContext as never);
      renewing = false;
      clearTimeout(timeout);
      await renewalLoop;
      const acknowledged = await transitionWhileLeased(jobId, lease, {
        status: 'succeeded',
        finished_at: clock(),
        lease_token: null,
        lease_expires_at: null,
      });
      if (acknowledged) {
        log('job succeeded', { jobId, type, attempt });
        await publishEvent('jobs.succeeded', { jobId, type, attempt });
      } else {
        // The lease was lost mid-run: a newer attempt owns the job. This
        // worker's side effects may already have happened (at-least-once).
        log('job acknowledgement lost its lease', { jobId, type, attempt });
      }
    } catch (error) {
      renewing = false;
      clearTimeout(timeout);
      await renewalLoop;
      const code = classifyFailure(error, abort.signal.aborted);
      const retryable = !(error instanceof NonRetryableJobError) && attempt < claimed.max_attempts;
      if (retryable) {
        const delay = backoffDelay(attempt, config, random);
        const acknowledged = await transitionWhileLeased(jobId, lease, {
          status: 'pending',
          available_at: new Date(clock().getTime() + delay),
          lease_token: null,
          lease_expires_at: null,
          last_error_code: code,
        });
        if (acknowledged) {
          log('job failed, retry scheduled', { jobId, type, attempt, code });
          await publishEvent('jobs.retry_scheduled', { jobId, type, attempt });
        }
      } else {
        log('job failed terminally', { jobId, type, attempt, code });
        await failTerminal(jobId, lease, type, attempt, code);
        await publishEvent('jobs.failed', { jobId, type, attempt });
      }
    }
  }

  /** Terminal failure behind the same fence as every other transition. */
  async function failTerminal(
    jobId: string,
    lease: Lease,
    type: string,
    attempt: number,
    code: JobErrorCode,
  ): Promise<void> {
    const acknowledged = await transitionWhileLeased(jobId, lease, {
      status: 'failed',
      finished_at: clock(),
      lease_token: null,
      lease_expires_at: null,
      last_error_code: code,
    });
    if (acknowledged) log('job failed', { jobId, type, attempt, code });
  }

  /** Maps a handler failure to the allowlisted error code, never raw text. */
  function classifyFailure(error: unknown, timedOut: boolean): JobErrorCode {
    if (error instanceof NonRetryableJobError) {
      return JOB_ERROR_CODES.includes(error.code) ? error.code : 'handler_error';
    }
    return timedOut ? 'handler_timeout' : 'handler_error';
  }

  /**
   * Crash recovery: running rows whose lease expired are returned to the queue
   * (or failed terminally when the final attempt was consumed). Runs in one
   * short transaction with `FOR UPDATE SKIP LOCKED`, so recovery never races a
   * live renewal into a double-claim. Events publish after the commit.
   */
  async function recoverExpiredLeases(): Promise<void> {
    const now = clock();
    const events: { event: JobEventName; jobId: string; type: string; attempt: number }[] = [];
    await options.db.transaction().execute(async (trx) => {
      const recovered = await sql<{
        id: string;
        type: string;
        attempts: number;
        max_attempts: number;
      }>`
        select "id", "type", "attempts", "max_attempts"
        from "background_job"
        where "tenant_id" = ${options.tenantId}
          and "status" = 'running'
          and "lease_expires_at" <= ${now.toISOString()}::timestamptz
        order by "lease_expires_at" asc
        limit ${config.concurrency}
        for update skip locked
      `.execute(trx);
      for (const row of recovered.rows) {
        const exhausted = row.attempts >= row.max_attempts;
        await sql`
          update "background_job"
          set "status" = ${exhausted ? 'failed' : 'pending'},
              "finished_at" = ${exhausted ? now.toISOString() : null}::timestamptz,
              "available_at" = ${now.toISOString()}::timestamptz,
              "lease_token" = null,
              "lease_expires_at" = null,
              "last_error_code" = 'lease_lost',
              "updated_at" = now()
          where "id" = ${row.id} and "tenant_id" = ${options.tenantId}
        `.execute(trx);
        events.push({
          event: exhausted ? 'jobs.failed' : 'jobs.retry_scheduled',
          jobId: row.id,
          type: row.type,
          attempt: row.attempts,
        });
      }
    });
    for (const event of events) {
      log('lease recovered', { jobId: event.jobId, type: event.type, attempt: event.attempt });
      await publishEvent(event.event, {
        jobId: event.jobId,
        type: event.type,
        attempt: event.attempt,
      });
    }
  }

  /** One deterministic cycle: recover, then process at most one job. */
  async function runOnce(): Promise<void> {
    if (stopped) return;
    await recoverExpiredLeases();
    const claimed = await claimOne();
    if (claimed === undefined) return;
    const execution = executeClaimed(claimed);
    inFlight.add(execution);
    try {
      await execution;
    } finally {
      inFlight.delete(execution);
    }
  }

  /** Current queue depth for the worker's tenant (Section 61). */
  async function getQueueStats(): Promise<QueueStats> {
    const now = clock();
    const [counts, oldest] = await Promise.all([
      sql<{ due: string; delayed: string; running: string; failed: string }>`
        select
          count(*) filter (where "status" = 'pending' and "available_at" <= now()) as "due",
          count(*) filter (where "status" = 'pending' and "available_at" > now()) as "delayed",
          count(*) filter (where "status" = 'running') as "running",
          count(*) filter (where "status" = 'failed') as "failed"
        from "background_job"
        where "tenant_id" = ${options.tenantId}
      `.execute(options.db),
      scoped()
        .selectFrom('background_job')
        .select('available_at')
        .where('status', '=', 'pending')
        .where('available_at', '<=', now)
        .orderBy('available_at', 'asc')
        .limit(1)
        .executeTakeFirst(),
    ]);
    const row = counts.rows[0];
    return {
      due: Number(row?.due ?? 0),
      delayed: Number(row?.delayed ?? 0),
      running: Number(row?.running ?? 0),
      failed: Number(row?.failed ?? 0),
      oldestDueSeconds:
        oldest === undefined
          ? null
          : Math.max(0, Math.round((now.getTime() - oldest.available_at.getTime()) / 1000)),
    };
  }

  /** The polling loop. Nothing here exists until `start()` is called. */
  function start(): void {
    if (running || stopped) return;
    running = true;
    const loop = (async () => {
      while (running) {
        try {
          await recoverExpiredLeases();
          for (let slot = 0; slot < config.concurrency && running; slot += 1) {
            const claimed = await claimOne();
            if (claimed === undefined) break;
            const execution = executeClaimed(claimed)
              .catch(() => undefined)
              .finally(() => inFlight.delete(execution));
            inFlight.add(execution);
          }
        } catch {
          log('worker cycle failed', {});
        }
        if (!running) break;
        await sleep(config.pollIntervalMs);
      }
    })();
    inFlight.add(
      loop.finally(() => {
        inFlight.delete(loop);
      }),
    );
  }

  /** Stops the loop and waits (bounded) for in-flight handlers. */
  async function stop(): Promise<void> {
    if (!running) {
      stopped = true;
      return;
    }
    running = false;
    stopped = true;
    await sleep(0);
    const pending = [...inFlight];
    if (pending.length === 0) return;
    await Promise.race([Promise.allSettled(pending), sleep(config.shutdownGraceMs)]);
  }

  return { start, stop, runOnce, getQueueStats };
}
