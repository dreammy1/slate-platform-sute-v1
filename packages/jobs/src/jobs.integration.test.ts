import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeDatabase, createDatabase, runMigrations, type Database } from '@slate/database';
import { createLogger, type LogFields } from '@slate/observability';
import {
  JobConflictError,
  NonRetryableJobError,
  createJobRegistry,
  createWorker,
  enqueue,
  getJob,
  type JobEventName,
  type JobEventPayload,
} from './index.ts';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';

const records: LogFields[] = [];
const logger = createLogger({
  env: { SLATE_ENV: 'test', LOG_LEVEL: 'debug' },
  sink: (_line, record) => {
    records.push(record);
  },
});

/** The sentinel that must never reach the log sink in any shape. */
const PAYLOAD_SENTINEL = 'SLATE-JOB-SECRET-9f2c';

describe.skipIf(!integrationEnabled())('@slate/jobs (integration)', () => {
  let isolated: IsolatedDatabase;
  let db: Kysely<Database>;
  let tenantA = '';
  let tenantB = '';
  let adminId = '';
  /** Advances with tests; claim/recovery compare against this clock. */
  let now = new Date('2026-01-01T00:00:00.000Z');
  const effects: string[] = [];
  const events: { name: JobEventName; payload: JobEventPayload }[] = [];
  const publisher = {
    publish: (name: JobEventName, payload: JobEventPayload) => {
      events.push({ name, payload });
    },
  };
  const clock = () => now;
  // Real 1ms pauses keep the renewal loop from spinning hot during tests.
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 1)));
  const random = () => 0;

  /** Handlers await these gates; tests resolve them to release a handler. */
  const gates = new Map<string, () => void>();
  function gateFor(jobId: string, attempt: number): Promise<void> {
    return new Promise<void>((resolve) => {
      gates.set(`${jobId}:${attempt}`, resolve);
    });
  }
  function releaseGate(jobId: string, attempt: number): void {
    const resolve = gates.get(`${jobId}:${attempt}`);
    if (resolve !== undefined) {
      gates.delete(`${jobId}:${attempt}`);
      resolve();
    }
  }

  const registry = createJobRegistry({
    'test.succeed': {
      parse: (raw) => {
        if (
          typeof raw !== 'object' ||
          raw === null ||
          typeof (raw as { value?: unknown }).value !== 'string'
        ) {
          throw new Error('value must be a string');
        }
        return raw as { value: string };
      },
      handler: async (context) => {
        effects.push(`succeed:${context.payload.value}:${context.attempt}`);
      },
    },
    'test.transient': {
      parse: (raw) => raw as { value: string },
      handler: async () => {
        throw new Error('transient failure');
      },
      maxAttempts: 2,
    },
    'test.permanent': {
      parse: (raw) => raw as { value: string },
      handler: async () => {
        throw new NonRetryableJobError('handler_error', 'referenced row is gone');
      },
      maxAttempts: 5,
    },
    // Blocks until the test releases its per-(job, attempt) gate; lets tests
    // hold a lease open and simulate a crashed worker deterministically.
    'test.blocking': {
      parse: (raw) => raw as { value: string },
      handler: async (context) => {
        effects.push(`blocking:${context.jobId}:${context.attempt}`);
        await gateFor(context.jobId, context.attempt);
      },
      maxAttempts: 3,
    },
  });

  /** Creates a worker bound to one tenant with deterministic timing. */
  const workerFor = (tenantId: string) =>
    createWorker({
      tenantId,
      db,
      registry,
      logger,
      publisher,
      config: { leaseSeconds: 60, renewalSeconds: 1, pollIntervalMs: 1 },
      clock,
      sleep,
      random,
    });

  beforeAll(async () => {
    isolated = await createIsolatedDatabase({ schemaPrefix: 'slate_jobs' });
    db = createDatabase({
      url: isolated.url,
      searchPath: isolated.schema,
      env: { SLATE_ENV: 'test' },
      logger,
      // Queue payloads are JSONB parameters: the sink must never see them.
      omitQueryParameters: true,
    });
    await runMigrations(db);

    const org = await db
      .insertInto('organization')
      .values({ name: 'Acme', slug: 'acme' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const tenants = await db
      .insertInto('tenant')
      .values([
        { organization_id: org.id, name: 'A', slug: 'a' },
        { organization_id: org.id, name: 'B', slug: 'b' },
      ])
      .returning('id')
      .execute();
    tenantA = tenants[0]!.id;
    tenantB = tenants[1]!.id;
    const admin = await db
      .insertInto('app_user')
      .values({ email: 'admin@example.test', display_name: 'Admin', password_hash: '' })
      .returning('id')
      .executeTakeFirstOrThrow();
    adminId = admin.id;
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
    if (isolated) await isolated.dispose();
  });

  /** Rows currently in the queue for one tenant (debug helper). */
  const rowsFor = async (tenantId: string) =>
    db.selectFrom('background_job').selectAll().where('tenant_id', '=', tenantId).execute();

  const auditCount = async (tenantId: string) =>
    (
      await db
        .selectFrom('audit_log')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('action', '=', 'jobs.enqueued')
        .execute()
    ).length;

  it('commits the job, the domain write and exactly one audit row together', async () => {
    const before = events.length;
    const result = await db.transaction().execute(async (trx) => {
      const marker = await trx
        .insertInto('audit_log')
        .values({
          tenant_id: tenantA,
          actor_user_id: adminId,
          action: 'test.domain.write',
          payload: {},
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const enqueued = await enqueue(
        trx,
        {
          registry,
          tenantId: tenantA,
          actorUserId: adminId,
          publisher,
        },
        {
          type: 'test.succeed',
          payload: { value: PAYLOAD_SENTINEL },
          idempotencyKey: 'domain-1',
        },
      );
      return { marker: marker.id, enqueued };
    });
    expect(result.enqueued.created).toBe(true);
    expect(await auditCount(tenantA)).toBe(1);
    // The notification publishes only after the outer transaction committed.
    await result.enqueued.notification?.publish();
    expect(events.slice(before)).toEqual([
      {
        name: 'jobs.enqueued',
        payload: {
          tenantId: tenantA,
          jobId: result.enqueued.jobId,
          type: 'test.succeed',
          attempt: 0,
        },
      },
    ]);
    // And the log sink never saw the payload sentinel.
    expect(JSON.stringify(records)).not.toContain(PAYLOAD_SENTINEL);
  });

  it('rolls the job back when the mandatory audit insert fails', async () => {
    await sql`alter table audit_log add constraint test_reject_jobs_audit check (action <> 'jobs.enqueued') not valid`.execute(
      db,
    );
    try {
      await expect(
        db.transaction().execute(async (trx) =>
          enqueue(
            trx,
            { registry, tenantId: tenantA },
            {
              type: 'test.succeed',
              payload: { value: 'rolled-back' },
              idempotencyKey: 'audit-fail',
            },
          ),
        ),
      ).rejects.toThrow();
      expect(
        await db
          .selectFrom('background_job')
          .select('id')
          .where('idempotency_key', '=', 'audit-fail')
          .execute(),
      ).toEqual([]);
    } finally {
      await sql`alter table audit_log drop constraint test_reject_jobs_audit`.execute(db);
    }
  });

  it('deduplicates an identical key and conflicts on a changed payload', async () => {
    const first = await db.transaction().execute((trx) =>
      enqueue(
        trx,
        { registry, tenantId: tenantA },
        {
          type: 'test.succeed',
          payload: { value: 'same' },
          idempotencyKey: 'dedupe',
        },
      ),
    );
    const duplicate = await db.transaction().execute((trx) =>
      enqueue(
        trx,
        { registry, tenantId: tenantA },
        {
          type: 'test.succeed',
          payload: { value: 'same' },
          idempotencyKey: 'dedupe',
        },
      ),
    );
    expect(duplicate).toEqual({ jobId: first.jobId, created: false });
    expect(await auditCount(tenantA)).toBe(2); // only the first enqueue audited

    await expect(
      db.transaction().execute((trx) =>
        enqueue(
          trx,
          { registry, tenantId: tenantA },
          {
            type: 'test.succeed',
            payload: { value: 'different' },
            idempotencyKey: 'dedupe',
          },
        ),
      ),
    ).rejects.toBeInstanceOf(JobConflictError);
  });

  it('rejects unregistered types and invalid payloads before anything is written', async () => {
    await expect(
      db.transaction().execute((trx) =>
        enqueue(
          trx,
          { registry, tenantId: tenantA },
          {
            type: 'ghost.task',
            payload: {},
            idempotencyKey: 'ghost',
          },
        ),
      ),
    ).rejects.toThrow(/not a registered job type/);
    await expect(
      db.transaction().execute((trx) =>
        enqueue(
          trx,
          { registry, tenantId: tenantA },
          {
            type: 'test.succeed',
            payload: { value: 42 } as unknown as { value: string },
            idempotencyKey: 'bad-payload',
          },
        ),
      ),
    ).rejects.toThrow(/was rejected/);
    const keys = (await rowsFor(tenantA)).map((row) => row.idempotency_key);
    expect(keys).not.toContain('ghost');
    expect(keys).not.toContain('bad-payload');
  });

  it('keeps tenants isolated: B cannot see, claim or acknowledge A jobs', async () => {
    const enqueued = await db.transaction().execute((trx) =>
      enqueue(
        trx,
        { registry, tenantId: tenantA },
        {
          type: 'test.succeed',
          payload: { value: 'for-a' },
          idempotencyKey: 'iso-1',
          availableAt: clock(),
        },
      ),
    );
    expect(await getJob(db, { tenantId: tenantB, jobId: enqueued.jobId })).toBeNull();
    expect((await getJob(db, { tenantId: tenantA, jobId: enqueued.jobId }))?.status).toBe(
      'pending',
    );

    await workerFor(tenantB).runOnce();
    expect((await getJob(db, { tenantId: tenantA, jobId: enqueued.jobId }))?.status).toBe(
      'pending',
    );

    await workerFor(tenantA).runOnce();
    expect(await getJob(db, { tenantId: tenantA, jobId: enqueued.jobId })).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    });
  });

  it('retries transient failures with backoff, then terminates on exhaustion', async () => {
    effects.length = 0;
    events.length = 0;
    // A leftover blocking row from the crash test below would otherwise be
    // claimed first (claim order is oldest-available-first), so drain tenant
    // A's queue back to empty before this focused lifecycle runs.
    await sql`delete from "background_job" where "tenant_id" = ${tenantA}::uuid`.execute(db);
    const enqueued = await db.transaction().execute((trx) =>
      enqueue(
        trx,
        { registry, tenantId: tenantA },
        {
          type: 'test.transient',
          payload: { value: 'x' },
          idempotencyKey: 'retry-1',
          maxAttempts: 2,
          availableAt: clock(),
        },
      ),
    );
    const worker = workerFor(tenantA);
    const eventsBefore = events.length;

    await worker.runOnce(); // attempt 1 fails → pending with future availability
    expect(await getJob(db, { tenantId: tenantA, jobId: enqueued.jobId })).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'handler_error',
    });

    await worker.runOnce(); // not yet due: nothing is claimed
    expect((await getJob(db, { tenantId: tenantA, jobId: enqueued.jobId }))?.attempts).toBe(1);

    now = new Date(now.getTime() + 10 * 60_000); // past the backoff window
    await worker.runOnce(); // attempt 2 fails → exhausted → terminal
    const job = await getJob(db, { tenantId: tenantA, jobId: enqueued.jobId });
    expect(job).toMatchObject({ status: 'failed', attempts: 2, lastErrorCode: 'handler_error' });
    expect(job?.finishedAt).not.toBeNull();

    const names = events.slice(eventsBefore).map((event) => event.name);
    expect(names).toEqual(['jobs.retry_scheduled', 'jobs.failed']);
  });

  it('fails a non-retryable job terminally on its first attempt', async () => {
    const enqueued = await db.transaction().execute((trx) =>
      enqueue(
        trx,
        { registry, tenantId: tenantA },
        {
          type: 'test.permanent',
          payload: { value: 'gone' },
          idempotencyKey: 'perm-1',
          maxAttempts: 5,
          availableAt: clock(),
        },
      ),
    );
    await workerFor(tenantA).runOnce();
    expect(await getJob(db, { tenantId: tenantA, jobId: enqueued.jobId })).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastErrorCode: 'handler_error',
    });
  });

  it('fails unknown types and unparseable payloads without running a handler', async () => {
    const effectsBefore = effects.length;
    await sql`
      insert into "background_job"
        ("tenant_id", "type", "payload", "idempotency_key", "status", "max_attempts", "available_at")
      values
        (${tenantA}::uuid, 'ghost.task', '{"value":"x"}'::jsonb, 'seed-unknown', 'pending', 3, ${clock().toISOString()}::timestamptz),
        (${tenantA}::uuid, 'test.succeed', '"not-an-object"'::jsonb, 'seed-invalid', 'pending', 3, ${clock().toISOString()}::timestamptz)
    `.execute(db);
    await workerFor(tenantA).runOnce();
    await workerFor(tenantA).runOnce();
    expect(effects.length).toBe(effectsBefore); // no handler ever ran
    const byKey = new Map((await rowsFor(tenantA)).map((row) => [row.idempotency_key, row]));
    expect(byKey.get('seed-unknown')).toMatchObject({
      status: 'failed',
      last_error_code: 'unknown_type',
    });
    expect(byKey.get('seed-invalid')).toMatchObject({
      status: 'failed',
      last_error_code: 'payload_invalid',
    });
  });

  it('recovers a crashed worker: expired lease redelivers, stale ack is fenced', async () => {
    effects.length = 0;
    events.length = 0;
    // Tenant A's queue is drained first for the same oldest-first reason as
    // the retry test above: only this crash fixture may be claimable here.
    await sql`delete from "background_job" where "tenant_id" = ${tenantA}::uuid`.execute(db);
    const enqueued = await db.transaction().execute((trx) =>
      enqueue(
        trx,
        { registry, tenantId: tenantA },
        {
          type: 'test.blocking',
          payload: { value: 'crash' },
          idempotencyKey: 'crash-1',
          availableAt: clock(),
        },
      ),
    );
    const jobId = enqueued.jobId;

    // "Worker 1" claims the job; its renewal loop is frozen (a crashed process
    // renews nothing), so its lease will expire on the fake clock.
    let releaseRenewal: () => void = () => undefined;
    const frozen = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    const crashedWorker = createWorker({
      tenantId: tenantA,
      db,
      registry,
      logger,
      publisher,
      config: { leaseSeconds: 60, renewalSeconds: 1, pollIntervalMs: 1 },
      clock,
      sleep: () => frozen,
      random,
    });
    const first = crashedWorker.runOnce();
    await vi.waitFor(() => {
      expect(effects).toContain(`blocking:${jobId}:1`);
    });
    expect(await getJob(db, { tenantId: tenantA, jobId })).toMatchObject({
      status: 'running',
      attempts: 1,
    });

    // The crash: the clock passes the (frozen) lease while attempt 1 is out.
    now = new Date(now.getTime() + 5 * 60_000);

    // "Worker 2" recovers the expired lease, reclaims and runs attempt 2.
    const secondWorker = workerFor(tenantA);
    const second = secondWorker.runOnce();
    await vi.waitFor(() => {
      expect(effects).toContain(`blocking:${jobId}:2`);
    });
    releaseGate(jobId, 2); // attempt 2 completes
    await second;
    expect(await getJob(db, { tenantId: tenantA, jobId })).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      lastErrorCode: 'lease_lost',
    });

    // The stale worker finally finishes: its ack carries the dead token, so
    // the fence rejects it — the newer attempt's state is never overwritten.
    releaseRenewal(); // unfreeze so runOnce's finally-path can settle
    releaseGate(jobId, 1);
    await first;
    expect(await getJob(db, { tenantId: tenantA, jobId })).toMatchObject({
      status: 'succeeded',
      attempts: 2,
    });
  });

  it('fails an exhausted attempt that lost its lease instead of redelivering', async () => {
    effects.length = 0;
    events.length = 0;
    await sql`
      insert into "background_job"
        ("tenant_id", "type", "payload", "idempotency_key", "status", "attempts",
         "max_attempts", "lease_token", "lease_expires_at", "available_at")
      values
        (${tenantA}::uuid, 'test.succeed', '{"value":"lost"}'::jsonb, 'exhausted-lease', 'running',
         3, 3, gen_random_uuid(), ${new Date(now.getTime() - 1000).toISOString()}::timestamptz,
         ${now.toISOString()}::timestamptz)
    `.execute(db);
    await workerFor(tenantA).runOnce(); // recovery only: nothing is claimable
    const row = (await rowsFor(tenantA)).find(
      (candidate) => candidate.idempotency_key === 'exhausted-lease',
    );
    expect(row).toMatchObject({
      status: 'failed',
      attempts: 3,
      last_error_code: 'lease_lost',
    });
    expect(row?.finished_at).not.toBeNull();
    expect(effects).not.toContain('succeed:lost:4');
  });

  it('never double-claims: parallel workers take distinct jobs', async () => {
    effects.length = 0;
    events.length = 0;
    const first = await db.transaction().execute((trx) =>
      enqueue(
        trx,
        { registry, tenantId: tenantA },
        {
          type: 'test.blocking',
          payload: { value: 'one' },
          idempotencyKey: 'conc-1',
          availableAt: clock(),
        },
      ),
    );
    const secondJob = await db.transaction().execute((trx) =>
      enqueue(
        trx,
        { registry, tenantId: tenantA },
        {
          type: 'test.blocking',
          payload: { value: 'two' },
          idempotencyKey: 'conc-2',
          availableAt: clock(),
        },
      ),
    );
    const workerLeft = workerFor(tenantA);
    const workerRight = workerFor(tenantA);
    // Fire both workers without awaiting — they block on gates, so awaiting
    // Promise.all here would deadlock (gates are released below).
    const left = workerLeft.runOnce();
    const right = workerRight.runOnce();
    // Wait until both handlers have started (pushed their effects).
    await vi.waitFor(() => {
      expect(effects).toContain(`blocking:${first.jobId}:1`);
      expect(effects).toContain(`blocking:${secondJob.jobId}:1`);
    });
    // No second attempts: each worker claimed a distinct job.
    expect(effects).not.toContain(`blocking:${first.jobId}:2`);
    expect(effects).not.toContain(`blocking:${secondJob.jobId}:2`);
    releaseGate(first.jobId, 1);
    releaseGate(secondJob.jobId, 1);
    await Promise.all([left, right]);
  });

  it('starts, polls idly and stops cleanly with no due work', async () => {
    effects.length = 0;
    events.length = 0;
    const worker = workerFor(tenantA);
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(worker.stop()).resolves.toBeUndefined();
    // runOnce after stop is a no-op, not an error.
    await expect(worker.runOnce()).resolves.toBeUndefined();
  });
});
