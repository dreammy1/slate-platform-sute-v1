/**
 * The `Kysely<Database>` connection factory.
 *
 * One factory, one place where `pg` pools, TLS and query logging are decided:
 *
 * - **Configuration** comes from `DATABASE_URL` (validated by `src/env.ts`, so
 *   a malformed URL throws at startup) or an explicit `url` for tests.
 * - **TLS** is negotiated outside local environments (`staging`, `preview`,
 *   `production`), never on a developer machine.
 * - **Query logging** is wired through `@slate/observability`: every query
 *   event is emitted at `debug` on a child logger, and every bound parameter
 *   is passed through `redactValue` (whose content layer is `scrubSecrets`)
 *   before it reaches the sink. A connection string or bearer token used as a
 *   parameter is therefore `[redacted]` in the log, never plaintext.
 *
 * Master Plan reference: Section 61 (observability baseline, no secrets in
 * logs), docs/adr/001-database-query-toolkit.md (Decision),
 * docs/phase2-agent-tasks.md (SLATE-200 logging contract).
 */

import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import { Pool, type PoolConfig } from 'pg';

import {
  createLogger,
  isLocalEnvironment,
  redactValue,
  type EnvironmentVariables,
  type LogContext,
  type Logger,
} from '@slate/observability';

import { databaseUrl } from './env.ts';
import type { Database } from './types.ts';

const ERROR_PREFIX = '[slate/database]';

/** Default maximum number of connections opened by one pool. */
export const DEFAULT_MAX_CONNECTIONS = 10;

/** PostgreSQL truncates identifiers at 63 bytes. */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * A search path must be a plain identifier: it is interpolated into the
 * server `options` connection parameter, so it is validated before it ever
 * reaches a connection string.
 */
const SEARCH_PATH_PATTERN = /^[a-z_][a-z0-9_]*$/;

/** Validates a search path used for per-request (or per-suite) schema scoping. */
export function assertSearchPath(searchPath: string): string {
  if (!SEARCH_PATH_PATTERN.test(searchPath) || searchPath.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(
      `${ERROR_PREFIX} searchPath "${searchPath}" is invalid: expected /${SEARCH_PATH_PATTERN.source}/ ` +
        `with at most ${MAX_IDENTIFIER_LENGTH} characters.`,
    );
  }
  return searchPath;
}

/**
 * Decides whether the pool negotiates TLS.
 *
 * Local environments (`development`, `test`) talk to a local Docker Postgres
 * without TLS; everything else - `staging`, `preview`, `production` - refuses
 * to run without certificate verification (Master Plan Section 61). An
 * explicit override wins, for tests and unusual deployments.
 */
export function resolveSslConfiguration(
  env: EnvironmentVariables,
  override: boolean | undefined,
): PoolConfig['ssl'] {
  if (override !== undefined) {
    return override ? { rejectUnauthorized: true } : undefined;
  }
  return isLocalEnvironment(env) ? undefined : { rejectUnauthorized: true };
}

/**
 * Redacts one batch of bound parameters before they are handed to the logger.
 *
 * Every value goes through `redactValue`, whose content layer is
 * `scrubSecrets`: a connection string, a `Bearer` header or a credential under
 * a sensitive key arrives as `[redacted]` instead of plaintext.
 */
export function redactQueryParameters(parameters: readonly unknown[]): readonly unknown[] {
  return parameters.map((parameter) => redactValue(parameter));
}

/**
 * The opt-in parameter-omission mode (ADR 004).
 *
 * Queue payloads are JSONB parameters whose *shape* (not just their values) is
 * tenant data, so heuristic redaction is not trusted for them: a queue
 * connection can be built with `omitQueryParameters`, which drops the
 * `parameters` field entirely — on the success path **and** on the error path.
 * Unrelated connections keep the redacted-parameter behaviour by default.
 */
export function createQueryLogger(
  logger: Logger,
  options: { readonly omitParameters?: boolean | undefined } = {},
): (event: LogEvent) => void {
  return (event: LogEvent) => {
    if (event.level === 'query') {
      logger.debug('sql query', {
        sql: event.query.sql,
        ...(options.omitParameters
          ? {}
          : { parameters: redactQueryParameters(event.query.parameters) }),
        durationMs: Math.round(event.queryDurationMillis),
      });
      return;
    }
    logger.error('sql query failed', {
      sql: event.query.sql,
      ...(options.omitParameters
        ? {}
        : { parameters: redactQueryParameters(event.query.parameters) }),
      err: event.error,
    });
  };
}

/** Options accepted by {@link createDatabase}. Everything is injectable for tests. */
export interface CreateDatabaseOptions {
  /** Connection string; defaults to `DATABASE_URL` read from `env`. */
  readonly url?: string | undefined;
  /** Environment map; defaults to `process.env`. */
  readonly env?: EnvironmentVariables | undefined;
  /** Logger; defaults to `createLogger(env)`, extended with `logBindings`. */
  readonly logger?: Logger | undefined;
  /** Fields attached to every query record, e.g. `{ requestId, tenantId }`. */
  readonly logBindings?: LogContext | undefined;
  /** Pool size; defaults to {@link DEFAULT_MAX_CONNECTIONS}. */
  readonly maxConnections?: number | undefined;
  /** Explicit TLS override; defaults to `resolveSslConfiguration(env)`. */
  readonly ssl?: boolean | undefined;
  /** Restricts unqualified queries to one schema (suite/request scoping). */
  readonly searchPath?: string | undefined;
  /**
   * Drops the `parameters` field from query logs entirely — both success and
   * error records. Opt-in for queue connections whose JSONB parameters carry
   * tenant data that must not reach the sink in any shape (ADR 004).
   */
  readonly omitQueryParameters?: boolean | undefined;
}

/**
 * Creates the shared `Kysely<Database>` client.
 *
 * The factory never connects by itself - the pool is lazy - but it *does*
 * validate the connection string, so a malformed `DATABASE_URL` throws the
 * moment the client is built, not on the first query.
 *
 * @example
 * ```ts
 * const db = createDatabase(); // reads DATABASE_URL
 * const rows = await db.selectFrom('organization').selectAll().execute();
 * await closeDatabase(db); // destroys the pool
 * ```
 */
export function createDatabase(options: CreateDatabaseOptions = {}): Kysely<Database> {
  const env = options.env ?? process.env;
  const url = options.url ?? databaseUrl(env);
  const logger = (options.logger ?? createLogger({ env })).child({
    component: 'db',
    ...options.logBindings,
  });

  const poolConfig: PoolConfig = {
    connectionString: url,
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    ssl: resolveSslConfiguration(env, options.ssl),
  };
  if (options.searchPath !== undefined) {
    poolConfig.options = `-c search_path=${assertSearchPath(options.searchPath)}`;
  }

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool(poolConfig) }),
    log: createQueryLogger(logger, { omitParameters: options.omitQueryParameters === true }),
  });
}

/** Closes the client: stops new queries and destroys the underlying pool. */
export async function closeDatabase(db: Kysely<Database>): Promise<void> {
  await db.destroy();
}
