import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, createDatabase, runMigrations, type Database } from '@slate/database';
import {
  JobConflictError,
  JobPayloadError,
  getJob,
  type JobEventName,
  type JobEventPayload,
} from '@slate/jobs';
import { createLogger } from '@slate/observability';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';

import { enqueueNotification, type NotificationPayload } from '../index.ts';

const logger = createLogger({ env: { SLATE_ENV: 'test' }, sink: () => undefined });

/**
 * `@slate/notifications` (SLATE-206) against real PostgreSQL.
 *
 * The Enqueue -> Deliver -> Retry -> Audit gate is owned by `@slate/jobs`; what
 * is proved here is the notification-specific half: a delivery request becomes a
 * durable `background_job` row of type `notification.deliver`, inside the
 * caller's transaction, with exactly one attributed audit row and tenant
 * isolation on the id, and nothing is announced before the commit.
 */
describe.skipIf(!integrationEnabled())('@slate/notifications (integration)', () => {
  let isolated: IsolatedDatabase;
  let db: Kysely<Database>;
  let tenantA = '';
  let tenantB = '';
  let adminId = '';
  /** Events the injected publisher received; asserted empty before the commit. */
  const events: { name: JobEventName; payload: JobEventPayload }[] = [];
  const publisher = {
    publish: (name: JobEventName, payload: JobEventPayload) => {
      events.push({ name, payload });
    },
  };

  beforeAll(async () => {
    isolated = await createIsolatedDatabase({ schemaPrefix: 'slate_notifications' });
    db = createDatabase({
      url: isolated.url,
      searchPath: isolated.schema,
      env: { SLATE_ENV: 'test' },
      logger,
      // Delivery payloads travel as JSONB parameters; the sink never sees them.
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

  const welcome = (recipient = 'user@example.test'): NotificationPayload => ({
    type: 'email',
    recipient,
    content: { template: 'welcome', params: { name: 'Alice' } },
  });

  it('commits the delivery job, exactly one audit row and a post-commit event', async () => {
    const result = await db
      .transaction()
      .execute((trx) =>
        enqueueNotification(
          trx,
          { tenantId: tenantA, actorUserId: adminId, publisher, idempotencyKey: 'notif-1' },
          welcome(),
        ),
      );
    expect(result.created).toBe(true);

    expect(await getJob(db, { tenantId: tenantA, jobId: result.jobId })).toMatchObject({
      type: 'notification.deliver',
      status: 'pending',
      attempts: 0,
    });

    // A job id is not a capability: the same id read in another tenant is null.
    expect(await getJob(db, { tenantId: tenantB, jobId: result.jobId })).toBeNull();

    const audits = await db
      .selectFrom('audit_log')
      .select(['action', 'resource_id'])
      .where('tenant_id', '=', tenantA)
      .where('resource_id', '=', result.jobId)
      .execute();
    expect(audits).toEqual([{ action: 'jobs.enqueued', resource_id: result.jobId }]);

    // Nothing is announced while the transaction is open: the caller publishes
    // the deferred notification only after `execute()` resolved.
    expect(events).toEqual([]);
    await result.notification?.publish();
    expect(events).toEqual([
      {
        name: 'jobs.enqueued',
        payload: {
          tenantId: tenantA,
          jobId: result.jobId,
          type: 'notification.deliver',
          attempt: 0,
        },
      },
    ]);
  });

  it('deduplicates an identical key and conflicts on a changed payload', async () => {
    const first = await db
      .transaction()
      .execute((trx) =>
        enqueueNotification(trx, { tenantId: tenantA, idempotencyKey: 'notif-dup' }, welcome()),
      );
    const again = await db
      .transaction()
      .execute((trx) =>
        enqueueNotification(trx, { tenantId: tenantA, idempotencyKey: 'notif-dup' }, welcome()),
      );
    expect(again).toMatchObject({ jobId: first.jobId, created: false });

    await expect(
      db
        .transaction()
        .execute((trx) =>
          enqueueNotification(
            trx,
            { tenantId: tenantA, idempotencyKey: 'notif-dup' },
            welcome('other@example.test'),
          ),
        ),
    ).rejects.toBeInstanceOf(JobConflictError);

    // Keys are unique per tenant, so the same key is a brand new job in B.
    const otherTenant = await db
      .transaction()
      .execute((trx) =>
        enqueueNotification(trx, { tenantId: tenantB, idempotencyKey: 'notif-dup' }, welcome()),
      );
    expect(otherTenant.created).toBe(true);
    expect(otherTenant.jobId).not.toBe(first.jobId);
  });

  it('refuses a payload the job definition rejects before writing anything', async () => {
    // The definition owns payload validation: persisted JSON is untrusted input.
    const invalid = {
      type: 'pager',
      recipient: 'user@example.test',
      content: {},
    } as unknown as NotificationPayload;

    await expect(
      db
        .transaction()
        .execute((trx) =>
          enqueueNotification(trx, { tenantId: tenantA, idempotencyKey: 'notif-bad' }, invalid),
        ),
    ).rejects.toBeInstanceOf(JobPayloadError);

    const rows = await db
      .selectFrom('background_job')
      .select('id')
      .where('tenant_id', '=', tenantA)
      .where('idempotency_key', '=', 'notif-bad')
      .execute();
    expect(rows).toEqual([]);
  });
});
