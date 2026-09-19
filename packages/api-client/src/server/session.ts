import { createHmac, timingSafeEqual } from 'node:crypto';

import { assertServerOnly } from './guard.ts';

assertServerOnly('@slate/api-client/server (session)');

/**
 * The session cookie codec (SLATE-300, ADR 008 §5).
 *
 * A session is an HMAC-signed payload carried in an `httpOnly` cookie: the browser
 * sends it back automatically and cannot read or forge it. The payload holds the
 * user id and, optionally, the tenant the session is *currently bound to* — never
 * the tenants the user is authorized for. Authorization is read from the database
 * on every request instead, so revoking a membership takes effect immediately
 * rather than whenever a token happens to expire.
 *
 * Verification never throws: anything malformed, unsigned, signed with the wrong
 * key or expired is simply "no session", and the caller decides what that means.
 */

/** The session cookie's name, matching the API's documented security scheme. */
export const SESSION_COOKIE_NAME = 'slate_session';

/** Shortest secret accepted; a weaker key undermines the whole scheme. */
export const MIN_SESSION_SECRET_LENGTH = 32;

/** Default lifetime: one working day. */
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

/** The signed content. Deliberately minimal: identity plus a tenant binding. */
export interface SessionPayload {
  readonly userId: string;
  /** Tenant this session acts in. Validated against membership on every request. */
  readonly tenantId?: string | undefined;
}

export interface SessionCodecOptions {
  /** Server-only secret. Read from the environment, never from a request. */
  readonly secret: string;
  readonly ttlSeconds?: number | undefined;
  /** Injected clock, so expiry is testable without waiting. */
  readonly now?: (() => Date) | undefined;
  /** `false` only for plain-HTTP local development. */
  readonly secure?: boolean | undefined;
}

export interface SessionCodec {
  /** Signs a new session token. */
  issue(payload: SessionPayload): string;
  /** Returns the payload, or `undefined` for anything that does not verify. */
  verify(token: string | undefined): SessionPayload | undefined;
  /** The `Set-Cookie` value that stores a token. */
  cookie(token: string): string;
  /** The `Set-Cookie` value that clears it. */
  clearCookie(): string;
}

/** Token version, so the format can change without silently accepting old tokens. */
const TOKEN_VERSION = 'v1';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Creates the codec.
 *
 * @throws when the secret is missing or too short — a weak key is a startup
 *   failure, not something to discover later.
 */
export function createSessionCodec(options: SessionCodecOptions): SessionCodec {
  const secret = options.secret;
  if (typeof secret !== 'string' || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters; ` +
        'refusing to sign sessions with a weak key (ADR 008 §5).',
    );
  }

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const now = options.now ?? ((): Date => new Date());
  const secure = options.secure ?? true;
  const cookieAttributes = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');

  function signatureFor(body: string): string {
    return createHmac('sha256', secret).update(body).digest('base64url');
  }

  return {
    issue(payload) {
      const issued: SessionPayload & { iat: number; exp: number } = {
        userId: payload.userId,
        ...(payload.tenantId === undefined ? {} : { tenantId: payload.tenantId }),
        iat: Math.floor(now().getTime() / 1000),
        exp: Math.floor(now().getTime() / 1000) + ttlSeconds,
      };
      const body = base64url(JSON.stringify(issued));
      return `${TOKEN_VERSION}.${body}.${signatureFor(body)}`;
    },

    verify(token) {
      if (typeof token !== 'string' || token === '') return undefined;
      const parts = token.split('.');
      if (parts.length !== 3) return undefined;
      const [version, body, signature] = parts as [string, string, string];
      if (version !== TOKEN_VERSION) return undefined;

      const expected = Buffer.from(signatureFor(body));
      const actual = Buffer.from(signature);
      // Length must match before the constant-time compare, which throws otherwise.
      if (expected.length !== actual.length) return undefined;
      if (!timingSafeEqual(expected, actual)) return undefined;

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return undefined;
      }
      if (typeof parsed !== 'object' || parsed === null) return undefined;

      const candidate = parsed as { userId?: unknown; tenantId?: unknown; exp?: unknown };
      if (typeof candidate.userId !== 'string' || candidate.userId.trim() === '') return undefined;
      if (typeof candidate.exp !== 'number' || candidate.exp * 1000 <= now().getTime()) {
        return undefined;
      }
      return {
        userId: candidate.userId,
        ...(typeof candidate.tenantId === 'string' ? { tenantId: candidate.tenantId } : {}),
      };
    },

    cookie(token) {
      return `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes}; Max-Age=${ttlSeconds}`;
    },

    clearCookie() {
      return `${SESSION_COOKIE_NAME}=; ${cookieAttributes}; Max-Age=0`;
    },
  };
}
