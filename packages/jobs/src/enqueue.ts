/**
 * Transactional enqueue (ADR 004).
 *
 * `enqueue(trx, ...)` requires a caller-owned transaction: the domain write,
 * the `background_job` row and exactly one `jobs.enqueued` audit row commit
 * together or not at all. An audit failure rolls the whole command back, and a
 * second connection can never observe an uncommitted job. Duplicate
 * `(tenant_id, type, idempotency_key)` submissions return the original row
 * without a second audit line; the same key with a different payload is a
 * conflict, never a silent overwrite.
 */

import { sql, type Kysely } from 'kysely';

import { createTenantDatabase, type Database } from '@slate/database';

import { JobConflictError, JobPayloadError, JobRegistryError } from './errors.ts';
import {
  assertIdempotencyKey,
  assertJobTypeName,
  assertMaxAttempts,
  serializeJobPayload,
  type JobPayload,
  type JobRegistryMap,
} from './registry.ts';

/** Default retry budget when neither the definition nor the caller sets one. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** The lifecycle events `@slate/jobs` emits; payloads never include job data. */
export type JobEventName =
  'jobs.enqueued' | 'jobs.succeeded' | 'jobs.failed' | 'jobs.retry_scheduled';

/** A payload of `{ tenantId, jobId, type, attempt }` — metadata only. */
export interface JobEventPayload {
  readonly tenantId: string;
  readonly jobId: string;
  readonly type: string;
  readonly attempt: number;
}

/**
 * The host-bridged publisher. `@slate/jobs` never imports `@slate/api`: the
 * application injects an adapter onto its own bus. Publishing happens only
 * after the corresponding transaction commits, and a publisher failure must
 * never undo committed state (the events stay best-effort).
 */
export interface JobEventPublisher {
  publish(event: JobEventName, payload: JobEventPayload): Promise<void> | void;
}

/** Server-derived context for an enqueue; a client never supplies these. */
export interface EnqueueContext {
  /** Registry of allowed job types (the whole enqueue surface). */
  readonly registry: JobRegistryMap;
  readonly tenantId: string;
  readonly actorUserId?: string | undefined;
  readonly requestId?: string | undefined;
  /** Optional event bridge; when absent no notification is returned. */
  readonly publisher?: JobEventPublisher | undefined;
}

/** The caller's enqueue command (typed by the registry). */
export interface EnqueueInput<M extends JobRegistryMap, K extends keyof M & string> {
  readonly type: K;
  readonly payload: JobPayload<M, K>;
  /** Stable caller-chosen key; the same key deduplicates, a change conflicts. */
  readonly idempotencyKey: string;
  /** Schedule later than now; defaults to immediate (database `now()`). */
  readonly availableAt?: Date | undefined;
  /** Retry budget override (1–10); defaults to the definition, then 3. */
  readonly maxAttempts?: number | undefined;
}

/** A deferred, post-commit notification for one newly enqueued job. */
export interface JobNotification {
  /** Call exactly once, after the outer transaction has committed. */
  publish: () => Promise<void>;
}

export interface EnqueueResult {
  readonly jobId: string;
  /** `false` for an identical duplicate; no audit row and no event for those. */
  readonly created: boolean;
  /** Present only for a new job, and only when a publisher was provided. */
  readonly notification?: JobNotification | undefined;
}

/**
 * Enqueues one job inside `trx` (a `Kysely<Database>` client or one of its
 * transactions — passing the transaction is what makes the whole command
 * atomic; any client works structurally).
 */
export async function enqueue<M extends JobRegistryMap, K extends keyof M & string>(
  trx: Kysely<Database>,
  context: EnqueueContext,
  input: EnqueueInput<M, K>,
): Promise<EnqueueResult> {
  assertJobTypeName(input.type);
  const definition = context.registry[input.type];
  if (definition === undefined) {
    throw new JobRegistryError(
      `"${input.type}" is not a registered job type; the registry owns the entire job surface.`,
    );
  }
  assertIdempotencyKey(input.idempotencyKey);
  const maxAttempts = assertMaxAttempts(
    input.maxAttempts ?? definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  );
  if (input.availableAt !== undefined && Number.isNaN(input.availableAt.getTime())) {
    throw new JobPayloadError('availableAt is not a valid date.');
  }

  // Parse first: a payload the definition rejects never reaches the database.
  let parsed: unknown;
  try {
    parsed = definition.parse(input.payload);
  } catch (error) {
    if (error instanceof JobPayloadError) throw error;
    throw new JobPayloadError(
      `payload for "${input.type}" was rejected: ${error instanceof Error ? error.message : 'invalid payload'}.`,
    );
  }
  const payloadText = serializeJobPayload(parsed);
  const availableAt = input.availableAt ?? sql`now()`;

  const scoped = createTenantDatabase(trx, context.tenantId);
  const inserted = await scoped
    .insertInto('background_job', {
      type: input.type as string,
      status: 'pending' as const,
      payload: JSON.parse(payloadText) as unknown,
      idempotency_key: input.idempotencyKey,
      max_attempts: maxAttempts,
      available_at: availableAt as Date,
      actor_user_id: context.actorUserId ?? null,
      request_id: context.requestId ?? null,
    })
    .onConflict((conflict) =>
      conflict.columns(['tenant_id', 'type', 'idempotency_key']).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();

  if (inserted === undefined) {
    // A row with this key already exists: identical payload deduplicates, a
    // different payload is a conflict (never a silent overwrite).
    const existing = await scoped
      .selectFrom('background_job')
      .select(['id', 'payload'])
      .where('type', '=', input.type)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirstOrThrow();
    if (serializeJobPayload(existing.payload) !== payloadText) {
      throw new JobConflictError(
        `idempotency key "${input.idempotencyKey}" is already used by job ${existing.id} with a different payload.`,
      );
    }
    return { jobId: existing.id, created: false };
  }

  const jobId = inserted.id;
  // Exactly one audit row per accepted enqueue, inside the same transaction:
  // an audit failure rolls the job row back with it.
  await scoped
    .insertInto('audit_log', {
      actor_user_id: context.actorUserId ?? null,
      action: 'jobs.enqueued',
      resource_type: 'background_job',
      resource_id: jobId,
      payload: { type: input.type },
    })
    .execute();

  const publisher = context.publisher;
  return {
    jobId,
    created: true,
    ...(publisher === undefined
      ? {}
      : {
          notification: {
            publish: () =>
              Promise.resolve(
                publisher.publish('jobs.enqueued', {
                  tenantId: context.tenantId,
                  jobId,
                  type: input.type,
                  attempt: 0,
                }),
              ),
          },
        }),
  };
}
