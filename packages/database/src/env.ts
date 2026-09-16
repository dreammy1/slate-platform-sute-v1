/**
 * The environment contract of the database layer.
 *
 * Every reader takes the environment map as an argument instead of reaching for
 * `process.env` directly, mirroring `@slate/observability/env`: parsing stays
 * pure and testable, and a misconfiguration is reported as a thrown error from
 * *this* module - with the variable name in the message - instead of surfacing
 * later as a baffling connection failure. An invalid value never falls back to
 * a default; it fails startup.
 *
 * Error messages echo the offending value only after {@link scrubSecrets}, so
 * the password of a malformed connection string can never end up in a log or
 * an exception trace.
 *
 * Master Plan reference: Section 30 (environment configuration), Section 61
 * (no secrets in logs), docs/adr/001-database-query-toolkit.md (Decision).
 */

import { scrubSecrets } from '@slate/observability';

/** Environment map read by every helper in this package. */
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/** Variable holding the primary (pooled) application connection string. */
export const DATABASE_URL_VARIABLE = 'DATABASE_URL';

/** Variable holding the direct, non-pooled connection string used by migrations. */
export const DIRECT_URL_VARIABLE = 'DIRECT_URL';

/** Connection-string schemes accepted by {@link parseDatabaseUrl}. */
export const POSTGRES_URL_SCHEMES = ['postgresql:', 'postgres:'] as const;

const ERROR_PREFIX = '[slate/database]';

/**
 * Parses and validates a PostgreSQL connection string.
 *
 * A malformed URL must throw at startup (never fallback), so the check runs on
 * every read - both `DATABASE_URL` and `DIRECT_URL` are validated before a
 * pool is ever created. Only a sanitized form of the input is echoed in the
 * error message: credentials are scrubbed, not trusted.
 */
export function parseDatabaseUrl(url: string, variable: string): URL {
  const candidate = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      `${ERROR_PREFIX} ${variable}="${scrubSecrets(candidate)}" is invalid: expected a ` +
        `postgresql:// connection string like postgresql://user:password@host:5432/database.`,
    );
  }

  if (!(POSTGRES_URL_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    throw new Error(
      `${ERROR_PREFIX} ${variable}="${scrubSecrets(candidate)}" is invalid: expected the ` +
        `${POSTGRES_URL_SCHEMES.join(' or ')} scheme, got "${parsed.protocol}".`,
    );
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (database === '') {
    throw new Error(
      `${ERROR_PREFIX} ${variable}="${scrubSecrets(candidate)}" is invalid: the connection ` +
        `string must name a database (postgresql://user:password@host:5432/<database>).`,
    );
  }

  return parsed;
}

/**
 * The primary application connection string (`DATABASE_URL`).
 *
 * @throws when the variable is missing, blank, or not a valid postgresql URL.
 */
export function databaseUrl(env: EnvironmentVariables = process.env): string {
  return requireDatabaseUrl(env, DATABASE_URL_VARIABLE);
}

/**
 * The direct, non-pooled connection string used by the migration runner
 * (`DIRECT_URL`). Kept separate from {@link databaseUrl} because poolers
 * (PgBouncer, pgcat) may not support transactional DDL or advisory locks.
 *
 * @throws when the variable is missing, blank, or not a valid postgresql URL.
 */
export function directDatabaseUrl(env: EnvironmentVariables = process.env): string {
  return requireDatabaseUrl(env, DIRECT_URL_VARIABLE);
}

function requireDatabaseUrl(env: EnvironmentVariables, variable: string): string {
  const value = env[variable]?.trim();
  if (value === undefined || value === '') {
    throw new Error(
      `${ERROR_PREFIX} ${variable} is not set. Point it at a PostgreSQL connection string ` +
        `(postgresql://user:password@host:5432/database) or copy ".env.example" to ".env".`,
    );
  }
  parseDatabaseUrl(value, variable);
  return value;
}
