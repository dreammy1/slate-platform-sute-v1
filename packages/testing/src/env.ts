import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { config as loadDotenv } from 'dotenv';

import { findRepoRoot } from './paths.ts';

/** Environment variable holding the connection string of the test database. */
export const TEST_DATABASE_URL_VARIABLE = 'TEST_DATABASE_URL';

/** Path of the environment template shipped with the repository. */
export const ENV_EXAMPLE_FILE_NAME = '.env.example';

/** Path of the (git-ignored) local environment file. */
export const ENV_FILE_NAME = '.env';

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * CI detection used by the presets *and* by the integration guard: a missing
 * test database may only ever downgrade to a skip on a developer machine.
 */
export function isCi(env: Environment = process.env): boolean {
  const value = env['CI']?.trim().toLowerCase();
  if (value === undefined || value === '') {
    return false;
  }
  return value !== 'false' && value !== '0';
}

export interface LoadRootEnvOptions {
  /** Directory used to locate the monorepo root; defaults to `process.cwd()`. */
  readonly cwd?: string | undefined;
  /** Explicit `.env` path; skips root discovery when provided. */
  readonly path?: string | undefined;
  /** Let `.env` values replace variables that are already defined. */
  readonly override?: boolean | undefined;
}

export interface LoadRootEnvResult {
  /** The path that was resolved, whether or not it exists. */
  readonly path: string;
  /** `true` when a file was found and parsed. */
  readonly loaded: boolean;
}

/**
 * Loads the repository root `.env` into `process.env`, exactly like Docker
 * Compose does for the local stack. Pre-existing variables win, so an explicit
 * shell or CI value always overrides the developer's local file.
 */
export function loadRootEnv(options: LoadRootEnvOptions = {}): LoadRootEnvResult {
  const envPath = options.path ?? join(findRepoRoot(options.cwd ?? process.cwd()), ENV_FILE_NAME);

  if (!existsSync(envPath)) {
    return { path: envPath, loaded: false };
  }

  loadDotenv({ path: envPath, override: options.override ?? false, quiet: true });
  return { path: envPath, loaded: true };
}

/** The configured test database URL, or `undefined` when unset/blank. */
export function testDatabaseUrl(env: Environment = process.env): string | undefined {
  const value = env[TEST_DATABASE_URL_VARIABLE]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** `true` when an isolated test database is configured. */
export function integrationEnabled(env: Environment = process.env): boolean {
  return testDatabaseUrl(env) !== undefined;
}

/**
 * The configured test database URL, or a descriptive error explaining how to
 * provision one. Called by the harness right before it opens a connection, so
 * failures point at the missing configuration instead of at a socket timeout.
 */
export function requireTestDatabaseUrl(env: Environment = process.env): string {
  const url = testDatabaseUrl(env);
  if (url === undefined) {
    throw new Error(
      `[slate/testing] ${TEST_DATABASE_URL_VARIABLE} is not set. Start the local stack with "docker compose up -d", copy "${ENV_EXAMPLE_FILE_NAME}" to "${ENV_FILE_NAME}", or point ${TEST_DATABASE_URL_VARIABLE} at an isolated PostgreSQL database. Integration tests never touch DATABASE_URL.`,
    );
  }
  return url;
}
