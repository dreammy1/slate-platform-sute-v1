/**
 * The code-owned job registry.
 *
 * Master Plan Section 60 and ADR 004: only trusted server code registers job
 * types. A definition pairs a versioned, dotted, namespaced `type` with a
 * `parse` function that validates arbitrary (persisted-JSON) input into a
 * typed payload, and a handler that runs inside one tenant's scope. The
 * registry is the entire attack surface boundary: a type absent from it can
 * never be enqueued, and a stored row whose type is unknown or whose payload
 * fails `parse` is failed terminally **without** the handler running.
 */

import type { TenantScopedDatabase } from '@slate/database';
import type { Logger } from '@slate/observability';

import { JobPayloadError, JobRegistryError } from './errors.ts';

/** Serialized payload ceiling; rejects before persistence (ADR 004). */
export const MAX_PAYLOAD_BYTES = 16_384;

/** Longest accepted job type / idempotency key, mirroring the 0006 CHECKs. */
export const MAX_JOB_TYPE_LENGTH = 128;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** Dotted, namespaced, versioned job type (`module.action` or `module.action.v2`). */
const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** What a handler receives. `db` is confined to one tenant; never the root client. */
export interface JobHandlerContext<TPayload> {
  readonly tenantId: string;
  readonly jobId: string;
  readonly type: string;
  /** The payload exactly as the definition's `parse` produced it. */
  readonly payload: TPayload;
  /** 1-based execution attempt (incremented at claim time). */
  readonly attempt: number;
  readonly requestId: string | undefined;
  /** Tenant-scoped reads/writes; cross-tenant access is not expressible. */
  readonly db: TenantScopedDatabase;
  /** Child logger bound with tenantId/jobId/type/attempt. */
  readonly logger: Logger;
  /** Aborted on timeout, shutdown or lease loss; cancellation is cooperative. */
  readonly signal: AbortSignal;
}

/** One registered job type. `parse` must throw for invalid persisted input. */
export interface JobDefinition<TPayload> {
  /** Validates raw JSON into the typed payload (also runs at enqueue time). */
  readonly parse: (raw: unknown) => TPayload;
  /** The work. Must tolerate at-least-once redelivery (ADR 004). */
  readonly handler: (context: JobHandlerContext<TPayload>) => Promise<void> | void;
  /** Per-type retry budget override (1–10); falls back to the enqueue default. */
  readonly maxAttempts?: number;
}

/** Any definition, payload-erased. `JobDefinition<Foo>` is assignable to this. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobDefinition = JobDefinition<any>;

/** A registry map: job type -> definition, one payload type per entry. */
export type JobRegistryMap = Readonly<Record<string, AnyJobDefinition>>;

/** The payload type a registry entry owns. */
export type JobPayload<M extends JobRegistryMap, K extends keyof M & string> = ReturnType<
  M[K]['parse']
>;

/**
 * Builds a registry map. Identity at runtime — this exists so the *type* is
 * explicit at the call site and so a future registry-level invariant has one
 * place to live. Invalid type names are rejected here, before any enqueue.
 */
export function createJobRegistry<M extends JobRegistryMap>(map: M): M {
  for (const type of Object.keys(map)) {
    assertJobTypeName(type);
    const definition = map[type];
    if (typeof definition?.parse !== 'function' || typeof definition?.handler !== 'function') {
      throw new JobRegistryError(`job type "${type}" needs both parse and handler.`);
    }
    if (definition.maxAttempts !== undefined) {
      assertMaxAttempts(definition.maxAttempts);
    }
  }
  return map;
}

/** Validates a job type name; throws for malformed or over-long input. */
export function assertJobTypeName(type: string): string {
  if (
    typeof type !== 'string' ||
    !JOB_TYPE_PATTERN.test(type) ||
    type.length > MAX_JOB_TYPE_LENGTH
  ) {
    throw new JobRegistryError(
      `"${String(type).slice(0, 64)}" is not a valid job type: expected a dotted, namespaced name of at most ${MAX_JOB_TYPE_LENGTH} characters.`,
    );
  }
  return type;
}

/** Validates a retry budget against the 1–10 bound the migration enforces. */
export function assertMaxAttempts(maxAttempts: number): number {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new JobRegistryError(`maxAttempts ${String(maxAttempts)} is not an integer in [1, 10].`);
  }
  return maxAttempts;
}

/** Validates an idempotency key (non-empty, bounded) before persistence. */
export function assertIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new JobRegistryError(
      `idempotency key must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }
  return key;
}

/**
 * Serializes a validated payload for the `jsonb` column.
 *
 * `undefined` payloads are rejected (a JSON column has no undefined), as is
 * anything over {@link MAX_PAYLOAD_BYTES}. The text is also what duplicate
 * detection compares against, so it must be canonical: object keys are sorted
 * deterministically before measuring and storing.
 */
export function serializeJobPayload(value: unknown): string {
  if (value === undefined) {
    throw new JobPayloadError('job payload resolved to undefined; nothing storable.');
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(canonicalize(value));
  } catch (error) {
    throw new JobPayloadError(
      `job payload is not serializable: ${error instanceof Error ? error.message : 'unknown error'}.`,
    );
  }
  if (text === undefined) {
    throw new JobPayloadError('job payload is not serializable to JSON.');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new JobPayloadError(
      `serialized job payload is ${Buffer.byteLength(text, 'utf8')} bytes; the limit is ${MAX_PAYLOAD_BYTES}.`,
    );
  }
  return text;
}

/** Canonical JSON: object keys sorted, so equal payloads stringify equally. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}
