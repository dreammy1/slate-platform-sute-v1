import { describe, expect, it, vi } from 'vitest';

import { assertServerOnly, isBrowserLike } from './guard.ts';
import {
  createSessionCodec,
  DEFAULT_SESSION_TTL_SECONDS,
  MIN_SESSION_SECRET_LENGTH,
  SESSION_COOKIE_NAME,
} from './session.ts';

const SECRET = 'unit-test-secret-that-is-long-enough!!';

describe('the server-only guard', () => {
  it('allows evaluation where no DOM exists', () => {
    expect(isBrowserLike()).toBe(false);
    expect(() => assertServerOnly('@slate/api-client/server (test)')).not.toThrow();
  });

  it('throws loudly the moment a browser global appears', () => {
    vi.stubGlobal('window', {});
    try {
      expect(isBrowserLike()).toBe(true);
      expect(() => assertServerOnly('@slate/api-client/server (test)')).toThrow(/server-only/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the session codec', () => {
  it('round-trips a payload, keeping the tenant binding optional', () => {
    const codec = createSessionCodec({ secret: SECRET });
    const withTenant = codec.verify(codec.issue({ userId: 'u1', tenantId: 't1' }));
    expect(withTenant).toEqual({ userId: 'u1', tenantId: 't1' });
    const withoutTenant = codec.verify(codec.issue({ userId: 'u2' }));
    expect(withoutTenant).toEqual({ userId: 'u2' });
  });

  it('expires a token after the ttl, using the injected clock', () => {
    let nowMs = 1_000_000;
    const codec = createSessionCodec({
      secret: SECRET,
      ttlSeconds: 60,
      now: () => new Date(nowMs),
    });
    const token = codec.issue({ userId: 'u1' });
    expect(codec.verify(token)).toBeDefined();
    nowMs += 60 * 1000;
    expect(codec.verify(token)).toBeUndefined();
  });

  it('refuses anything that does not verify: tamper, wrong version, garbage, empty', () => {
    const codec = createSessionCodec({ secret: SECRET });
    const token = codec.issue({ userId: 'u1', tenantId: 't1' });
    const [version, body, signature] = token.split('.');

    const tamperedBody = `${version}.${body!.slice(0, -2)}xx.${signature}`;
    expect(codec.verify(tamperedBody)).toBeUndefined();

    const tamperedSignature = `${version}.${body}.${signature!.slice(0, -1)}A`;
    expect(codec.verify(tamperedSignature)).toBeUndefined();

    expect(codec.verify(`v9.${body}.${signature}`)).toBeUndefined();
    expect(codec.verify('not-a-token')).toBeUndefined();
    expect(codec.verify('')).toBeUndefined();
    expect(codec.verify(undefined)).toBeUndefined();
  });

  it('binds the token to the issuing key', () => {
    const first = createSessionCodec({ secret: SECRET });
    const second = createSessionCodec({ secret: `${SECRET}-different-key-padding!!` });
    expect(second.verify(first.issue({ userId: 'u1' }))).toBeUndefined();
  });

  it('stores the token in an httpOnly, SameSite=Lax, Secure cookie by default', () => {
    const codec = createSessionCodec({ secret: SECRET });
    const cookie = codec.cookie('token-value');
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=token-value`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain(`Max-Age=${DEFAULT_SESSION_TTL_SECONDS}`);
    expect(codec.clearCookie()).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(codec.clearCookie()).toContain('Max-Age=0');
  });

  it('omits Secure only when explicitly allowed, for plain-HTTP local development', () => {
    const codec = createSessionCodec({ secret: SECRET, secure: false });
    expect(codec.cookie('t')).not.toContain('Secure');
    expect(codec.cookie('t')).toContain('HttpOnly');
  });

  it('refuses to sign with a weak or missing secret', () => {
    expect(() => createSessionCodec({ secret: 'short' })).toThrow(
      new RegExp(String(MIN_SESSION_SECRET_LENGTH)),
    );
    expect(() => createSessionCodec({ secret: '' })).toThrow();
    expect(() => createSessionCodec({ secret: undefined as unknown as string })).toThrow();
  });
});
