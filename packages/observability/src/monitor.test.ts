import { describe, expect, it } from 'vitest';

import { createLogger, type LogFields, type LogSink } from './logger.ts';
import {
  DEFAULT_FLUSH_TIMEOUT_MS,
  MAX_STACK_FRAMES,
  SDK_NAME,
  SDK_VERSION,
  SENTRY_ENVELOPE_CONTENT_TYPE,
  SENTRY_EVENT_LEVELS,
  buildSentryEnvelope,
  createErrorMonitor,
  createEventId,
  createFetchTransport,
  parseSentryDsn,
  parseStackFrames,
  type MonitorTransport,
  type MonitorTransportRequest,
  type SentryEvent,
} from './monitor.ts';
import { REDACTED_PLACEHOLDER } from './redact.ts';

const FIXED_TIME = new Date('2026-01-02T03:04:05.000Z');
const fixedNow = (): Date => FIXED_TIME;

/** A DSN whose public key and project id are recognisable in the assertions. */
const TEST_DSN = 'https://public-key@o0.ingest.sentry.io/123';

function captureSink(): { records: LogFields[]; sink: LogSink } {
  const records: LogFields[] = [];

  return {
    records,
    sink: (_line, record) => {
      records.push(record);
    },
  };
}

/** Records the requests that would have been sent, without touching the network. */
function collectingTransport(): {
  requests: MonitorTransportRequest[];
  transport: MonitorTransport;
} {
  const requests: MonitorTransportRequest[] = [];

  return {
    requests,
    transport: (request) => {
      requests.push(request);
      return Promise.resolve();
    },
  };
}

/** Parses one line of an envelope body (header, item header or event). */
function jsonLine(body: string, index: number): Record<string, unknown> {
  return JSON.parse(body.split('\n')[index] ?? '{}') as Record<string, unknown>;
}

describe('parseSentryDsn', () => {
  it('parses a hosted DSN into an envelope endpoint and an auth header', () => {
    expect(parseSentryDsn(`  ${TEST_DSN}  `)).toEqual({
      dsn: TEST_DSN,
      scheme: 'https',
      publicKey: 'public-key',
      host: 'o0.ingest.sentry.io',
      prefix: '',
      projectId: '123',
      envelopeUrl: 'https://o0.ingest.sentry.io/api/123/envelope/',
      authHeader: `Sentry sentry_version=7, sentry_client=${SDK_NAME}/${SDK_VERSION}, sentry_key=public-key`,
    });
  });

  it('keeps the prefix and the port of a self-hosted DSN', () => {
    const parsed = parseSentryDsn('http://key@errors.example.com:9000/sentry/42');

    expect(parsed.scheme).toBe('http');
    expect(parsed.host).toBe('errors.example.com:9000');
    expect(parsed.prefix).toBe('/sentry');
    expect(parsed.envelopeUrl).toBe('http://errors.example.com:9000/sentry/api/42/envelope/');
  });

  it('refuses a DSN it cannot trust instead of disabling monitoring quietly', () => {
    expect(() => parseSentryDsn('not a url')).toThrow(/is not a valid error-monitoring DSN/);
    expect(() => parseSentryDsn('ftp://key@host/1')).toThrow(/must use http or https/);
    expect(() => parseSentryDsn('https://o0.ingest.sentry.io/1')).toThrow(/missing its public key/);
    expect(() => parseSentryDsn('https://key@o0.ingest.sentry.io')).toThrow(
      /missing its project id/,
    );
    expect(() => parseSentryDsn('https://key@o0.ingest.sentry.io/slate')).toThrow(
      /numeric project id/,
    );
  });
});

describe('createEventId', () => {
  it('produces a 32-character hexadecimal id that differs per call', () => {
    const first = createEventId();

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(createEventId()).not.toBe(first);
  });
});

describe('buildSentryEnvelope', () => {
  it('writes the envelope header, the item header and the event as three lines', () => {
    const event: SentryEvent = {
      event_id: 'a'.repeat(32),
      timestamp: FIXED_TIME.toISOString(),
      platform: 'node',
      level: 'warning',
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      message: 'queue depth above threshold',
    };

    const envelope = buildSentryEnvelope(event, TEST_DSN, new Date('2026-01-02T03:04:06.000Z'));

    expect(envelope.split('\n')).toHaveLength(4);
    expect(jsonLine(envelope, 0)).toEqual({
      event_id: 'a'.repeat(32),
      dsn: TEST_DSN,
      sent_at: '2026-01-02T03:04:06.000Z',
    });
    expect(jsonLine(envelope, 1)).toEqual({ type: 'event', content_type: 'application/json' });
    expect(jsonLine(envelope, 2)).toEqual(event);
  });
});

describe('parseStackFrames', () => {
  it('turns V8 frames into Sentry frames, oldest first', () => {
    const stack = [
      'Error: boom',
      '    at captureOrder (/srv/app/orders.ts:42:11)',
      '    at Object.<anonymous> (/srv/app/server.ts:10:5)',
      '    at /srv/app/worker.ts:7:3',
    ].join('\n');

    expect(parseStackFrames(stack)).toEqual([
      { filename: '/srv/app/worker.ts', lineno: 7, colno: 3 },
      { filename: '/srv/app/server.ts', function: 'Object.<anonymous>', lineno: 10, colno: 5 },
      { filename: '/srv/app/orders.ts', function: 'captureOrder', lineno: 42, colno: 11 },
    ]);
  });

  it('ignores lines that are not frames', () => {
    expect(parseStackFrames('Error: boom\n    at Array.map (<anonymous>)')).toEqual([]);
  });

  it('caps a pathological stack at the frames closest to the error', () => {
    const lines = Array.from(
      { length: MAX_STACK_FRAMES + 10 },
      (_, index) => `    at frame${index} (/srv/app/file${index}.ts:${index + 1}:2)`,
    );

    const frames = parseStackFrames(lines.join('\n'));

    expect(frames).toHaveLength(MAX_STACK_FRAMES);
    expect(frames[0]).toEqual({
      filename: `/srv/app/file${MAX_STACK_FRAMES - 1}.ts`,
      function: `frame${MAX_STACK_FRAMES - 1}`,
      lineno: MAX_STACK_FRAMES,
      colno: 2,
    });
    expect(frames.at(-1)).toEqual({
      filename: '/srv/app/file0.ts',
      function: 'frame0',
      lineno: 1,
      colno: 2,
    });
  });
});

describe('createFetchTransport', () => {
  it('posts the envelope with the Sentry headers', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const transport = createFetchTransport((input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(new Response(null, { status: 202 }));
    });

    await transport({
      url: 'https://collector.example/api/1/envelope/',
      headers: { 'content-type': SENTRY_ENVELOPE_CONTENT_TYPE, 'x-sentry-auth': 'Sentry key' },
      body: 'the envelope',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://collector.example/api/1/envelope/');
    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.body).toBe('the envelope');
    expect(seen[0]?.init.headers).toEqual({
      'content-type': SENTRY_ENVELOPE_CONTENT_TYPE,
      'x-sentry-auth': 'Sentry key',
    });
  });

  it('rejects when the collector answers with an error status', async () => {
    const transport = createFetchTransport(() =>
      Promise.resolve(new Response(null, { status: 500 })),
    );

    await expect(
      transport({ url: 'https://collector.example/api/1/envelope/', headers: {}, body: '' }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('createErrorMonitor - disabled', () => {
  it('stays off without a DSN, says so once, and still returns event ids', async () => {
    const { records, sink } = captureSink();
    const logger = createLogger({ env: {}, level: 'debug', sink, now: fixedNow });
    const monitor = createErrorMonitor({ env: {}, logger });

    expect(monitor.enabled).toBe(false);
    expect(monitor.environment).toBe('development');
    expect(monitor.release).toBeUndefined();
    expect(monitor.captureException(new Error('nothing to report'))).toMatch(/^[0-9a-f]{32}$/);
    expect(monitor.captureMessage('nothing to report')).toMatch(/^[0-9a-f]{32}$/);
    await expect(monitor.flush()).resolves.toBe(true);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'warn',
      msg: 'error monitoring is disabled: no error-monitoring DSN is configured',
      variable: 'SENTRY_DSN',
    });
  });

  it('honours the break-glass flag even when a DSN is configured', () => {
    const { records, sink } = captureSink();
    const logger = createLogger({ env: {}, level: 'debug', sink, now: fixedNow });
    const monitor = createErrorMonitor({
      env: { SENTRY_DSN: TEST_DSN, SLATE_DISABLE_ERROR_MONITORING: '1' },
      logger,
    });

    expect(monitor.enabled).toBe(false);
    expect(records[0]).toMatchObject({
      level: 'debug',
      msg: 'error monitoring is disabled by configuration',
      variable: 'SLATE_DISABLE_ERROR_MONITORING',
    });
  });

  it('lets the explicit option win over both the DSN and the flag', () => {
    const { transport } = collectingTransport();

    // Monitoring needs an endpoint: `enabled: true` cannot invent one.
    expect(createErrorMonitor({ env: {}, enabled: true }).enabled).toBe(false);
    expect(createErrorMonitor({ env: { SENTRY_DSN: TEST_DSN }, enabled: false }).enabled).toBe(
      false,
    );
    expect(
      createErrorMonitor({
        env: { SENTRY_DSN: TEST_DSN, SLATE_DISABLE_ERROR_MONITORING: '1' },
        enabled: true,
        transport,
      }).enabled,
    ).toBe(true);
  });
});

describe('createErrorMonitor - capture', () => {
  it('sends a redacted exception event through the injected transport', async () => {
    const { requests, transport } = collectingTransport();
    const monitor = createErrorMonitor({
      dsn: TEST_DSN,
      service: 'slate-api',
      environment: 'test',
      release: 'r-9',
      env: {},
      now: fixedNow,
      transport,
    });

    expect(monitor.enabled).toBe(true);
    expect(monitor.environment).toBe('test');
    expect(monitor.release).toBe('r-9');

    const eventId = monitor.captureException(new TypeError('totals mismatch'), {
      orderId: 'o-9',
      password: 'hunter2',
    });

    await expect(monitor.flush()).resolves.toBe(true);

    expect(requests).toHaveLength(1);
    const request = requests[0] as MonitorTransportRequest;
    expect(request.url).toBe('https://o0.ingest.sentry.io/api/123/envelope/');
    expect(request.headers['content-type']).toBe(SENTRY_ENVELOPE_CONTENT_TYPE);
    expect(request.headers['x-sentry-auth']).toContain('sentry_key=public-key');

    expect(jsonLine(request.body, 0)).toEqual({
      event_id: eventId,
      dsn: TEST_DSN,
      sent_at: FIXED_TIME.toISOString(),
    });
    expect(jsonLine(request.body, 1)).toEqual({ type: 'event', content_type: 'application/json' });
    expect(jsonLine(request.body, 2)).toMatchObject({
      event_id: eventId,
      timestamp: FIXED_TIME.toISOString(),
      platform: 'node',
      level: 'error',
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      logger: 'slate-api',
      environment: 'test',
      release: 'r-9',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'totals mismatch',
            stacktrace: { frames: expect.any(Array) },
          },
        ],
      },
      extra: { orderId: 'o-9', password: REDACTED_PLACEHOLDER },
    });
  });

  it('captures a message with a level, tags and redacted context', async () => {
    const { requests, transport } = collectingTransport();
    const monitor = createErrorMonitor({ dsn: TEST_DSN, env: {}, now: fixedNow, transport });

    monitor.captureMessage('retry budget exhausted for postgres://app:pw@db:5432/slate', {
      level: 'warning',
      tags: { route: '/orders' },
      context: { apiKey: 'k' },
    });
    await monitor.flush();

    const event = jsonLine((requests[0] as MonitorTransportRequest).body, 2);

    expect(event).toMatchObject({
      level: 'warning',
      message: `retry budget exhausted for postgres://app:${REDACTED_PLACEHOLDER}@db:5432/slate`,
      tags: { route: '/orders' },
      extra: { apiKey: REDACTED_PLACEHOLDER },
    });
    expect(event).not.toHaveProperty('exception');
    expect(event).not.toHaveProperty('release');
  });
});

describe('createErrorMonitor - resilience', () => {
  it('reports the protocol vocabulary and the flush budget', () => {
    expect(SENTRY_EVENT_LEVELS).toEqual(['debug', 'info', 'warning', 'error', 'fatal']);
    expect(DEFAULT_FLUSH_TIMEOUT_MS).toBe(2_000);
  });

  it('resolves flush immediately when nothing is in flight', async () => {
    const { transport } = collectingTransport();
    const monitor = createErrorMonitor({ dsn: TEST_DSN, env: {}, now: fixedNow, transport });

    await expect(monitor.flush()).resolves.toBe(true);
  });

  it('reports a flush timeout instead of hanging shutdown', async () => {
    let releaseTransport = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    const monitor = createErrorMonitor({
      dsn: TEST_DSN,
      env: {},
      now: fixedNow,
      transport: () => gate,
    });

    monitor.captureMessage('slow collector');
    await expect(monitor.flush(1)).resolves.toBe(false);

    releaseTransport();

    await expect(monitor.flush(1_000)).resolves.toBe(true);
  });

  it('logs a transport failure and never throws out of the call site', async () => {
    const { records, sink } = captureSink();
    const logger = createLogger({ env: {}, level: 'debug', sink, now: fixedNow });
    const monitor = createErrorMonitor({
      dsn: TEST_DSN,
      env: {},
      now: fixedNow,
      logger,
      transport: () => Promise.reject(new Error('network down')),
    });

    monitor.captureException(new Error('boom'));
    await expect(monitor.flush()).resolves.toBe(true);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'warn',
      msg: 'error monitoring transport failed',
      err: { message: 'network down' },
    });
  });

  it('drops the overflow instead of growing without bound', async () => {
    const { records, sink } = captureSink();
    const logger = createLogger({ env: {}, level: 'debug', sink, now: fixedNow });
    let releaseTransport = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    const monitor = createErrorMonitor({
      dsn: TEST_DSN,
      env: {},
      now: fixedNow,
      logger,
      maxPending: 1,
      transport: () => gate,
    });

    const first = monitor.captureException(new Error('first'));
    const second = monitor.captureException(new Error('second'));

    expect(second).not.toBe(first);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'warn',
      msg: 'error monitoring is saturated: dropping an event',
      eventId: second,
      maxPending: 1,
      droppedEvents: 1,
    });

    releaseTransport();
    await monitor.flush();
  });
});
