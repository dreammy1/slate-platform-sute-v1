import { describe, expect, it } from 'vitest';
import { Kysely, type LogEvent } from 'kysely';

import { createLogger, type LogFields } from '@slate/observability';

import {
  DEFAULT_MAX_CONNECTIONS,
  assertSearchPath,
  closeDatabase,
  createDatabase,
  createQueryLogger,
  redactQueryParameters,
  resolveSslConfiguration,
} from './client.ts';

const VALID_URL = 'postgresql://slate:slate_dev_password@localhost:5432/slate?schema=public';
const CONNECTION_STRING_PARAM = 'postgresql://svc:hunter2@db.internal:5432/slate';
const BEARER_PARAM = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature';

interface Capture {
  readonly records: LogFields[];
  readonly logger: ReturnType<typeof createLogger>;
}

function captureLogger(level: LogFields['level'] = 'debug'): Capture {
  const records: LogFields[] = [];
  const logger = createLogger({
    env: { LOG_LEVEL: level, SLATE_ENV: 'test' },
    sink: (_line, record) => {
      records.push(record);
    },
  });
  return { records, logger };
}

function queryEvent(parameters: unknown[]): LogEvent {
  return {
    level: 'query',
    query: { sql: 'insert into audit_log (payload) values ($1)', parameters },
    queryDurationMillis: 12.4,
  } as unknown as LogEvent;
}

describe('redactQueryParameters', () => {
  it('scrubs credentials embedded in string parameters', () => {
    const redacted = redactQueryParameters([CONNECTION_STRING_PARAM, BEARER_PARAM, 42, null]);
    expect(redacted[0]).toBe('postgresql://svc:[redacted]@db.internal:5432/slate');
    expect(redacted[1]).toBe('Bearer [redacted]');
    expect(redacted[2]).toBe(42);
    expect(redacted[3]).toBeNull();
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
  });

  it('redacts sensitive keys inside structured parameters', () => {
    expect(redactQueryParameters([{ token: 'abc', email: 'a@b.example', name: 'ok' }])).toEqual([
      { token: '[redacted]', email: 'a@b.example', name: 'ok' },
    ]);
  });
});

describe('createQueryLogger', () => {
  it('emits query events at debug with redacted parameters', () => {
    const { records, logger } = captureLogger('debug');
    createQueryLogger(logger)(queryEvent([CONNECTION_STRING_PARAM]));

    expect(records).toHaveLength(1);
    const record = records[0] as LogFields;
    expect(record.level).toBe('debug');
    expect(record.msg).toBe('sql query');
    expect(record['sql']).toBe('insert into audit_log (payload) values ($1)');
    expect(record['durationMs']).toBe(12);
    expect(JSON.stringify(record)).not.toContain('hunter2');
    expect(JSON.stringify(record)).toContain('[redacted]');
  });

  it('emits query failures at error, equally redacted', () => {
    const { records, logger } = captureLogger('debug');
    createQueryLogger(logger)({
      level: 'error',
      error: new Error('boom'),
      query: { sql: 'select 1', parameters: [CONNECTION_STRING_PARAM] },
      queryDurationMillis: 3,
    } as unknown as LogEvent);

    const record = records[0] as LogFields;
    expect(record.level).toBe('error');
    expect(JSON.stringify(record)).not.toContain('hunter2');
  });

  it('is silenced when the logger level hides debug', () => {
    const { records, logger } = captureLogger('info');
    createQueryLogger(logger)(queryEvent(['x']));
    expect(records).toHaveLength(0);
  });
});

describe('resolveSslConfiguration', () => {
  it('disables TLS for local environments', () => {
    expect(resolveSslConfiguration({ NODE_ENV: 'development' }, undefined)).toBeUndefined();
    expect(resolveSslConfiguration({ NODE_ENV: 'test' }, undefined)).toBeUndefined();
  });

  it('requires verified TLS outside local environments (staging/preview/production)', () => {
    for (const environment of ['staging', 'preview', 'production']) {
      expect(resolveSslConfiguration({ SLATE_ENV: environment }, undefined)).toEqual({
        rejectUnauthorized: true,
      });
    }
  });

  it('honours an explicit override', () => {
    expect(resolveSslConfiguration({ NODE_ENV: 'production' }, false)).toBeUndefined();
    expect(resolveSslConfiguration({ NODE_ENV: 'test' }, true)).toEqual({
      rejectUnauthorized: true,
    });
  });
});

describe('assertSearchPath', () => {
  it('accepts plain identifiers', () => {
    expect(assertSearchPath('slate_test_abc123')).toBe('slate_test_abc123');
  });

  it('rejects injection attempts and malformed identifiers', () => {
    expect(() => assertSearchPath('public; drop schema public')).toThrow(/\[slate\/database\]/);
    expect(() => assertSearchPath('slate"test')).toThrow();
    expect(() => assertSearchPath('')).toThrow();
  });
});

describe('createDatabase', () => {
  it('rejects a malformed connection string at startup', () => {
    expect(() => createDatabase({ env: { DATABASE_URL: 'not a url' } })).toThrow(
      /\[slate\/database\]/,
    );
  });

  it('defaults to the documented pool size', () => {
    expect(DEFAULT_MAX_CONNECTIONS).toBeGreaterThan(0);
  });

  it('builds a client from an explicit url without connecting, and closes it', async () => {
    const db = createDatabase({ url: VALID_URL, env: { SLATE_ENV: 'test' } });
    expect(db).toBeInstanceOf(Kysely);
    await closeDatabase(db);
  });

  it('reads DATABASE_URL from the injected environment', async () => {
    const db = createDatabase({ env: { DATABASE_URL: VALID_URL, SLATE_ENV: 'test' } });
    await closeDatabase(db);
  });
});
