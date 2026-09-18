import { describe, expect, it } from 'vitest';

import {
  JobConflictError,
  JobPayloadError,
  JobRegistryError,
  NonRetryableJobError,
  type JobErrorCode,
} from './errors.ts';
import {
  DEFAULT_JOB_LIST_LIMIT,
  MAX_JOB_LIST_LIMIT,
  decodeJobCursor,
  encodeJobCursor,
  resolveJobListLimit,
  resolveJobListStatus,
} from './inspection.ts';
import {
  MAX_PAYLOAD_BYTES,
  assertIdempotencyKey,
  assertJobTypeName,
  assertMaxAttempts,
  createJobRegistry,
  serializeJobPayload,
} from './registry.ts';
import { DEFAULT_WORKER_CONFIG, backoffDelay, resolveWorkerConfig } from './worker.ts';

describe('createJobRegistry', () => {
  it('accepts a well-formed registry and keeps the map', () => {
    const registry = createJobRegistry({
      'email.send': { parse: (raw) => raw as { to: string }, handler: () => undefined },
      'media.resize.v2': { parse: (raw) => raw as { width: number }, handler: () => undefined },
    });
    expect(Object.keys(registry)).toEqual(['email.send', 'media.resize.v2']);
  });

  it.each(['locale', 'Email.Send', 'trailing.', '.leading', 'double..dot', `${'a'.repeat(129)}.x`])(
    'rejects the malformed type "%s"',
    (type) => {
      expect(() =>
        createJobRegistry({ [type]: { parse: (raw) => raw, handler: () => undefined } }),
      ).toThrow(JobRegistryError);
    },
  );

  it('rejects definitions without parse or handler', () => {
    expect(() =>
      // @ts-expect-error exercising the runtime guard for an incomplete entry
      createJobRegistry({ 'x.y': { parse: (raw) => raw } }),
    ).toThrow(JobRegistryError);
  });

  it('rejects an out-of-range per-type retry budget', () => {
    expect(() =>
      createJobRegistry({
        'x.y': { parse: (raw) => raw, handler: () => undefined, maxAttempts: 11 },
      }),
    ).toThrow(JobRegistryError);
  });
});

describe('payload serialization', () => {
  it('is canonical: key order never changes the text', () => {
    expect(serializeJobPayload({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      serializeJobPayload({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });

  it('rejects undefined and cyclic payloads before persistence', () => {
    expect(() => serializeJobPayload(undefined)).toThrow(JobPayloadError);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => serializeJobPayload(cyclic)).toThrow(JobPayloadError);
  });

  it('enforces the 16 KiB serialized bound', () => {
    const oversized = { blob: 'x'.repeat(MAX_PAYLOAD_BYTES) };
    expect(() => serializeJobPayload(oversized)).toThrow(/limit is/);
  });

  it('validates idempotency keys and retry budgets', () => {
    expect(() => assertIdempotencyKey('')).toThrow(JobRegistryError);
    expect(() => assertIdempotencyKey('k'.repeat(129))).toThrow(JobRegistryError);
    expect(assertIdempotencyKey('order-1')).toBe('order-1');
    expect(() => assertMaxAttempts(0)).toThrow(JobRegistryError);
    expect(assertMaxAttempts(10)).toBe(10);
    expect(assertJobTypeName('email.send.v2')).toBe('email.send.v2');
  });
});

describe('retry backoff', () => {
  const config = { backoffBaseMs: 1000, backoffCapMs: 60_000 };

  it('doubles per attempt and never exceeds the cap', () => {
    expect(backoffDelay(1, config, () => 0)).toBe(1000);
    expect(backoffDelay(2, config, () => 0)).toBe(2000);
    expect(backoffDelay(7, config, () => 0)).toBe(60_000);
    expect(backoffDelay(50, config, () => 0)).toBe(60_000);
  });

  it('adds jitter from the injected source, still capped', () => {
    expect(backoffDelay(1, config, () => 0.5)).toBe(1500);
    expect(backoffDelay(7, config, () => 0.99)).toBe(60_000);
  });
});

describe('worker config resolution', () => {
  it('fills defaults and validates the merged result', () => {
    expect(resolveWorkerConfig(undefined)).toEqual(DEFAULT_WORKER_CONFIG);
    expect(resolveWorkerConfig({ concurrency: 3 }).concurrency).toBe(3);
    expect(() => resolveWorkerConfig({ concurrency: 11 })).toThrow(/concurrency/);
    expect(() => resolveWorkerConfig({ renewalSeconds: 120, leaseSeconds: 60 })).toThrow(
      /renewalSeconds/,
    );
  });
});

describe('job list validation', () => {
  it('bounds the limit and validates the status filter', () => {
    expect(resolveJobListLimit(undefined)).toBe(DEFAULT_JOB_LIST_LIMIT);
    expect(resolveJobListLimit(100)).toBe(100);
    expect(() => resolveJobListLimit(MAX_JOB_LIST_LIMIT + 1)).toThrow(JobPayloadError);
    expect(() => resolveJobListLimit(Number.NaN)).toThrow(JobPayloadError);
    expect(resolveJobListStatus('pending')).toBe('pending');
    expect(resolveJobListStatus(undefined)).toBeUndefined();
    expect(() => resolveJobListStatus('running; drop table')).toThrow(JobPayloadError);
  });
});

describe('cursor round trip', () => {
  it('encodes and decodes an opaque (created_at, id) token', () => {
    const createdAt = new Date('2026-01-02T03:04:05.678Z');
    const id = '11111111-1111-4111-8111-111111111111';
    const decoded = decodeJobCursor(encodeJobCursor(createdAt, id));
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(decoded.id).toBe(id);
  });

  it('rejects tampered or malformed cursors as input errors', () => {
    expect(() => decodeJobCursor('not-a-cursor')).toThrow(JobPayloadError);
    expect(() => decodeJobCursor(encodeJobCursor(new Date(), 'not-a-uuid'))).toThrow(
      JobPayloadError,
    );
    expect(() =>
      decodeJobCursor(Buffer.from('2026-01-01T00:00:00.000Z|', 'utf8').toString('base64url')),
    ).toThrow(JobPayloadError);
  });
});

describe('non-retryable failures', () => {
  it('keeps only allowlisted codes', () => {
    expect(new NonRetryableJobError('handler_error').code).toBe('handler_error');
    expect(new NonRetryableJobError('lease_lost').code).toBe('lease_lost');
    // An unknown code never reaches the database column.
    expect(new NonRetryableJobError('everything.broke' as JobErrorCode).code).toBe('handler_error');
  });

  it('carries a typed conflict error for reused idempotency keys', () => {
    expect(new JobConflictError('used')).toBeInstanceOf(Error);
  });
});
