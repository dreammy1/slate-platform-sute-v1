import { describe, expect, it } from 'vitest';

import {
  CIRCULAR_MARKER,
  DEFAULT_MAX_ARRAY_LENGTH,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SENSITIVE_KEY_TOKENS,
  MAX_DEPTH_MARKER,
  REDACTED_PLACEHOLDER,
  isSensitiveKey,
  redactValue,
  scrubSecrets,
} from './redact.ts';

describe('isSensitiveKey', () => {
  it('matches a token anywhere in the normalized key', () => {
    for (const key of [
      'password',
      'Password',
      'pass_word',
      'dbPassword',
      'apiKey',
      'api_key',
      'X-API-KEY',
      'xApiKey',
      'accessToken',
      'private_key',
      'cardNumber',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('leaves legitimate keys alone', () => {
    for (const key of ['shippingAddress', 'monkey', 'orderId', 'userId', 'createdAt', 'pinCode']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('ignores empty and separator-only keys', () => {
    expect(isSensitiveKey('')).toBe(false);
    expect(isSensitiveKey('---')).toBe(false);
  });

  it('accepts a custom token list, including an empty one', () => {
    expect(isSensitiveKey('customerEmail', ['email'])).toBe(true);
    expect(isSensitiveKey('customerEmail')).toBe(false);
    expect(isSensitiveKey('anything', [])).toBe(false);
  });

  it('ships the documented default tokens', () => {
    expect(DEFAULT_SENSITIVE_KEY_TOKENS).toContain('password');
    expect(DEFAULT_SENSITIVE_KEY_TOKENS).toContain('authorization');
  });
});

describe('scrubSecrets', () => {
  it('removes the password from a connection string', () => {
    expect(scrubSecrets('postgresql://slate:s3cret@localhost:5432/slate')).toBe(
      `postgresql://slate:${REDACTED_PLACEHOLDER}@localhost:5432/slate`,
    );
  });

  it('removes bearer tokens', () => {
    expect(scrubSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(
      `Authorization: Bearer ${REDACTED_PLACEHOLDER}`,
    );
  });

  it('leaves text without credentials untouched', () => {
    expect(scrubSecrets('order 42 confirmed for tenant acme')).toBe(
      'order 42 confirmed for tenant acme',
    );
    expect(scrubSecrets('Bearer')).toBe('Bearer');
  });
});

describe('redactValue - key layer', () => {
  it('replaces the value of a sensitive key, whatever it holds', () => {
    expect(
      redactValue({ orderId: 'o-1', password: 'hunter2', authorization: 'Bearer abc', token: 42 }),
    ).toEqual({
      orderId: 'o-1',
      password: REDACTED_PLACEHOLDER,
      authorization: REDACTED_PLACEHOLDER,
      token: REDACTED_PLACEHOLDER,
    });
  });

  it('redacts nested keys and honours a custom placeholder', () => {
    expect(redactValue({ tenant: { apiKey: 'k' } }, { placeholder: '***' })).toEqual({
      tenant: { apiKey: '***' },
    });
  });

  it('redacts sensitive keys inside arrays', () => {
    expect(redactValue([{ token: 'abc' }, { id: 1 }])).toEqual([
      { token: REDACTED_PLACEHOLDER },
      { id: 1 },
    ]);
  });
});

describe('redactValue - content layer', () => {
  it('scrubs credentials embedded in any string', () => {
    expect(
      redactValue({ url: 'postgres://app:pw@db:5432/slate', msg: 'sent Bearer abcdefgh12345' }),
    ).toEqual({
      url: `postgres://app:${REDACTED_PLACEHOLDER}@db:5432/slate`,
      msg: `sent Bearer ${REDACTED_PLACEHOLDER}`,
    });
  });

  it('keeps strings untouched when scrubStrings is off, apart from keys', () => {
    expect(
      redactValue(
        { note: 'postgres://app:pw@db:5432/slate', password: 'pw' },
        { scrubStrings: false },
      ),
    ).toEqual({
      note: 'postgres://app:pw@db:5432/slate',
      password: REDACTED_PLACEHOLDER,
    });
  });
});

describe('redactValue - JSON-safe structures', () => {
  it('converts dates, URLs, regular expressions and errors', () => {
    const redacted = redactValue({
      at: new Date('2026-01-02T03:04:05.000Z'),
      link: new URL('https://slate.example/orders?id=7'),
      pattern: /^[a-z]+$/i,
      err: new Error('Boom', { cause: new Error('root') }),
    }) as Record<string, unknown>;

    expect(redacted['at']).toBe('2026-01-02T03:04:05.000Z');
    expect(redacted['link']).toBe('https://slate.example/orders?id=7');
    expect(redacted['pattern']).toBe('/^[a-z]+$/i');
    expect(redacted['err']).toEqual({
      name: 'Error',
      message: 'Boom',
      stack: expect.any(String),
      cause: { name: 'Error', message: 'root', stack: expect.any(String) },
    });
  });

  it('summarizes binary payloads instead of writing their bytes', () => {
    expect(redactValue({ body: new Uint8Array([1, 2, 3, 4]) })).toEqual({
      body: '[binary 4 bytes]',
    });
    expect(redactValue(new ArrayBuffer(8))).toBe('[binary 8 bytes]');
  });

  it('turns Map and Set into plain JSON', () => {
    expect(
      redactValue({
        m: new Map<string, unknown>([
          ['token', 'abc'],
          ['id', 1],
        ]),
      }),
    ).toEqual({
      m: { token: REDACTED_PLACEHOLDER, id: 1 },
    });
    expect(redactValue({ s: new Set([1, 2]) })).toEqual({ s: [1, 2] });
  });

  it('passes primitives through', () => {
    expect(redactValue('plain')).toBe('plain');
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
    expect(redactValue(7n)).toBe('7n');
    expect(redactValue(Symbol('s'))).toBe('Symbol(s)');
    expect(
      redactValue(function named() {
        return 1;
      }),
    ).toBe('[function named]');
  });
});

describe('redactValue - bounds', () => {
  it('replaces values beyond the depth limit', () => {
    let nested: Record<string, unknown> = { value: 'leaf' };
    for (let level = 0; level < DEFAULT_MAX_DEPTH + 2; level += 1) {
      nested = { nested };
    }

    let cursor: unknown = redactValue(nested);
    let depth = 0;
    while (typeof cursor === 'object' && cursor !== null && 'nested' in cursor) {
      cursor = (cursor as Record<string, unknown>)['nested'];
      depth += 1;
    }

    expect(cursor).toBe(MAX_DEPTH_MARKER);
    expect(depth).toBe(DEFAULT_MAX_DEPTH);
  });

  it('truncates long arrays and Maps with a readable marker', () => {
    const items = Array.from({ length: DEFAULT_MAX_ARRAY_LENGTH + 5 }, (_, index) => index);
    const redacted = redactValue(items) as unknown[];

    expect(redacted).toHaveLength(DEFAULT_MAX_ARRAY_LENGTH + 1);
    expect(redacted.at(-1)).toBe('[5 more items]');

    const entries = new Map([
      ['k0', 0],
      ['k1', 1],
      ['k2', 2],
    ]);
    expect(redactValue(entries, { maxArrayLength: 1 })).toEqual({
      k0: 0,
      '[truncated]': '2 more entries',
    });
  });

  it('honours custom limits and tokens', () => {
    expect(redactValue({ email: 'a@b.example' }, { tokens: ['email'] })).toEqual({
      email: REDACTED_PLACEHOLDER,
    });
    expect(redactValue([1, 2, 3], { maxArrayLength: 2 })).toEqual([1, 2, '[1 more items]']);
    expect(redactValue({ a: { b: 1 } }, { maxDepth: 1 })).toEqual({ a: MAX_DEPTH_MARKER });
  });

  it('cuts cycles but still expands a shared reference twice', () => {
    const shared = { id: 'shared' };
    const cyclic: Record<string, unknown> = { shared, other: shared };
    cyclic['self'] = cyclic;

    expect(redactValue(cyclic)).toEqual({
      shared: { id: 'shared' },
      other: { id: 'shared' },
      self: CIRCULAR_MARKER,
    });
  });

  it('never mutates the input', () => {
    const input = { password: 'hunter2', nested: { token: 'abc' }, list: [1, 2] };
    const snapshot = structuredClone(input);

    redactValue(input);

    expect(input).toEqual(snapshot);
  });
});
