/**
 * Environment contract for the auth layer.
 *
 * Every reader takes the environment map as an argument instead of reaching for
 * `process.env` directly, mirroring `@slate/database/env` and
 * `@slate/observability/env`.
 */

/** Variable holding the (deprecated stub) bcrypt/argon2 pepper. */
export const AUTH_PEPPER_VARIABLE = 'SLATE_AUTH_PEPPER';

function display(env: AuthEnvironment, variable: string): string {
  const raw = env[variable]?.trim() ?? '';
  return raw === '' ? 'unset' : `set (${[...raw].length} chars)`;
}

/** Sanitized representation of the auth secret variables, for startup logs. */
export function describeSecrets(env: AuthEnvironment): string {
  return [
    `${AUTH_PEPPER_VARIABLE}=${display(env, AUTH_PEPPER_VARIABLE)}`,
    `DATABASE_URL=${display(env, 'DATABASE_URL')}`,
  ].join('; ');
}

/** Auth-specific environment variables (all optional; none are required yet). */
export type AuthEnvironment = Readonly<
  Record<string, string | undefined> & {
    // The database layer's variables are referenced here for documentation
    // only; the auth layer reads them through @slate/database/env.
    readonly DATABASE_URL?: string | undefined;
    readonly DIRECT_URL?: string | undefined;
    // Auth pepper (stub; real hashing is a security ADR deferred beyond SLATE-202).
    readonly [AUTH_PEPPER_VARIABLE]?: string | undefined;
  }
>;

/**
 * Whether a secret-affecting variable is loaded.
 *
 * Used by startup logs and by tests to assert the pepper is unset (the stub
 * path). Does **not** scrub the value — callers do that when logging.
 */
export function hasAuthPepper(env: AuthEnvironment = process.env): boolean {
  const value = env[AUTH_PEPPER_VARIABLE]?.trim();
  return value !== undefined && value !== '';
}
