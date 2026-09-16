import { describe, expect, it } from 'vitest';

import {
  RESERVED_LOG_FIELDS,
  createLogger,
  formatLogRecord,
  formatLogRecordPretty,
  type LogFields,
  type LogSink,
} from './logger.ts';
import { REDACTED_PLACEHOLDER } from './redact.ts';

/** Captures what would have been written instead of writing it. */
function captureSink(): { lines: string[]; records: LogFields[]; sink: LogSink } {
  const lines: string[] = [];
  const records: LogFields[] = [];

  return {
    lines,
    records,
    sink: (line, record) => {
      lines.push(line);
      records.push(record);
    },
  };
}

const FIXED_TIME = new Date('2026-01-02T03:04:05.000Z');
const fixedNow = (): Date => FIXED_TIME;

describe('createLogger - configuration', () => {
  it('reads the environment, so a container needs no code change', () => {
    const logger = createLogger({
      env: {
        SLATE_SERVICE: 'slate-api',
        SLATE_ENV: 'production',
        LOG_LEVEL: 'warn',
        LOG_FORMAT: 'json',
        SENTRY_RELEASE: 'r-1',
      },
      sink: () => undefined,
    });

    expect(logger.service).toBe('slate-api');
    expect(logger.environment).toBe('production');
    expect(logger.level).toBe('warn');
    expect(logger.format).toBe('json');
    expect(logger.release).toBe('r-1');
  });

  it('defaults to the platform identity on a developer machine', () => {
    const logger = createLogger({ env: {}, sink: () => undefined });

    expect(logger.service).toBe('slate-platform');
    expect(logger.environment).toBe('development');
    expect(logger.level).toBe('debug');
    expect(logger.format).toBe('json');
    expect(logger.release).toBeUndefined();
  });

  it('uses a human-readable format only on an interactive local terminal', () => {
    expect(createLogger({ env: {}, isTty: true, sink: () => undefined }).format).toBe('pretty');
    expect(
      createLogger({ env: { SLATE_ENV: 'staging' }, isTty: true, sink: () => undefined }).format,
    ).toBe('json');
  });

  it('refuses a mistyped level instead of silently falling back', () => {
    expect(() => createLogger({ env: { LOG_LEVEL: 'verbose' } })).toThrow(
      /LOG_LEVEL="verbose" is invalid/,
    );
  });
});

describe('createLogger - record shape', () => {
  it('writes one JSON line with the fixed fields followed by the context', () => {
    const { lines, records, sink } = captureSink();
    const logger = createLogger({
      service: 'slate-api',
      environment: 'test',
      level: 'debug',
      sink,
      now: fixedNow,
    });

    logger.info('order confirmed', { orderId: 'o-1' });

    expect(records).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      level: 'info',
      time: '2026-01-02T03:04:05.000Z',
      msg: 'order confirmed',
      service: 'slate-api',
      environment: 'test',
      orderId: 'o-1',
    });
  });

  it('omits the release field when it is unknown', () => {
    const { records, sink } = captureSink();
    createLogger({ env: {}, level: 'debug', sink, now: fixedNow }).info('hello');

    expect('release' in (records[0] ?? {})).toBe(false);
  });

  it('applies bindings to every record and lets the call context win', () => {
    const { records, sink } = captureSink();
    const logger = createLogger({
      env: {},
      level: 'debug',
      sink,
      now: fixedNow,
      bindings: { requestId: 'r-1', tenantId: 'acme' },
    });

    logger.info('first');
    logger.warn('second', { tenantId: 'other' });

    expect(records[0]).toMatchObject({ requestId: 'r-1', tenantId: 'acme' });
    expect(records[1]).toMatchObject({ requestId: 'r-1', tenantId: 'other' });
  });

  it('derives children that override bindings without touching the parent', () => {
    const { records, sink } = captureSink();
    const parent = createLogger({
      env: {},
      level: 'debug',
      sink,
      now: fixedNow,
      bindings: { requestId: 'r-1', tenantId: 'acme' },
    });

    const child = parent.child({ tenantId: 'child' });
    child.info('from the child');
    parent.info('from the parent');

    expect(child.bindings).toEqual({ requestId: 'r-1', tenantId: 'child' });
    expect(parent.bindings).toEqual({ requestId: 'r-1', tenantId: 'acme' });
    expect(records[0]).toMatchObject({ tenantId: 'child' });
    expect(records[1]).toMatchObject({ tenantId: 'acme' });
  });

  it('owns its reserved fields: bindings and context cannot overwrite them', () => {
    const { records, sink } = captureSink();
    const impostor = {
      level: 'fatal',
      time: 'whenever',
      msg: 'not the real message',
      service: 'impostor',
      environment: 'impostor',
      release: 'impostor',
    };
    const logger = createLogger({
      service: 'slate-api',
      environment: 'test',
      level: 'debug',
      sink,
      now: fixedNow,
      bindings: impostor,
    });

    logger.info('real message', { ...impostor, orderId: 'o-2' });

    expect(logger.bindings).toEqual({});
    expect(records[0]).toEqual({
      level: 'info',
      time: '2026-01-02T03:04:05.000Z',
      msg: 'real message',
      service: 'slate-api',
      environment: 'test',
      orderId: 'o-2',
    });
    expect(RESERVED_LOG_FIELDS).toEqual([
      'level',
      'time',
      'msg',
      'service',
      'environment',
      'release',
    ]);
  });
});

describe('createLogger - level filtering', () => {
  it('drops records below the configured level and reports it through isEnabled', () => {
    const { records, sink } = captureSink();
    const logger = createLogger({ env: {}, level: 'warn', sink, now: fixedNow });

    logger.debug('dropped');
    logger.info('dropped');
    logger.warn('kept');
    logger.error('kept');
    logger.log('info', 'dropped as well');

    expect(records.map((record) => record.level)).toEqual(['warn', 'error']);
    expect(logger.isEnabled('debug')).toBe(false);
    expect(logger.isEnabled('info')).toBe(false);
    expect(logger.isEnabled('warn')).toBe(true);
    expect(logger.isEnabled('error')).toBe(true);
  });
});

describe('createLogger - redaction', () => {
  it('redacts sensitive context keys and scrubs secrets inside the message', () => {
    const { records, sink } = captureSink();
    const logger = createLogger({ env: {}, level: 'debug', sink, now: fixedNow });

    logger.info('connecting to postgres://app:pw@db:5432/slate', {
      password: 'hunter2',
      nested: { token: 'abc' },
    });

    expect(records[0]).toMatchObject({
      msg: `connecting to postgres://app:${REDACTED_PLACEHOLDER}@db:5432/slate`,
      password: REDACTED_PLACEHOLDER,
      nested: { token: REDACTED_PLACEHOLDER },
    });
  });

  it('serializes an error passed under err, including its cause', () => {
    const { records, sink } = captureSink();
    const logger = createLogger({ env: {}, level: 'debug', sink, now: fixedNow });

    logger.error('capture failed', {
      err: new TypeError('totals mismatch', { cause: new Error('db down') }),
      orderId: 'o-3',
    });

    expect(records[0]).toMatchObject({
      orderId: 'o-3',
      err: {
        name: 'TypeError',
        message: 'totals mismatch',
        stack: expect.any(String),
        cause: { name: 'Error', message: 'db down', stack: expect.any(String) },
      },
    });
  });

  it('can keep string content untouched while the key layer stays on', () => {
    const { records, sink } = captureSink();
    const logger = createLogger({
      env: {},
      level: 'debug',
      sink,
      now: fixedNow,
      redact: { scrubStrings: false },
    });

    logger.info('token=abcdefgh1234', { password: 'hunter2' });

    expect(records[0]).toMatchObject({ msg: 'token=abcdefgh1234', password: REDACTED_PLACEHOLDER });
  });
});

describe('createLogger - formats and call styles', () => {
  it('renders a single readable line in the pretty format', () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({
      service: 'slate-api',
      environment: 'local',
      level: 'debug',
      format: 'pretty',
      sink,
      now: fixedNow,
    });

    logger.info('order confirmed', {
      orderId: 'o-1',
      count: 2,
      note: 'two words',
      missing: undefined,
    });

    expect(lines[0]).toBe(
      '2026-01-02T03:04:05.000Z INFO  slate-api local order confirmed orderId=o-1 count=2 note="two words"',
    );
  });

  it('formats a record as JSON by default', () => {
    const { records, sink } = captureSink();
    createLogger({ env: {}, level: 'debug', sink, now: fixedNow }).info('hello', { a: 1 });

    const record = records[0] as LogFields;

    expect(formatLogRecord(record)).toBe(formatLogRecord(record, 'json'));
    expect(JSON.parse(formatLogRecord(record))).toMatchObject({ msg: 'hello', a: 1 });
    expect(formatLogRecord(record, 'pretty')).toBe(formatLogRecordPretty(record));
  });

  it('keeps working when a method is destructured', () => {
    const { records, sink } = captureSink();
    const logger = createLogger({
      env: {},
      level: 'debug',
      sink,
      now: fixedNow,
      bindings: { requestId: 'r-2' },
    });

    const { info } = logger;
    info('detached call');

    expect(records[0]).toMatchObject({ msg: 'detached call', requestId: 'r-2' });
  });
});
