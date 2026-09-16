/**
 * The migration runner: applies the raw SQL files from `src/migrations/` and
 * keeps a ledger.
 *
 * Design (ADR 001): raw, hand-written SQL driven by a minimal runner - no
 * hidden state, no binary. The runner is idempotent: the `slate_migrations`
 * ledger records each applied migration with its checksum, re-runs skip
 * applied ids, and *fails* when an already-applied file was edited (checksum
 * drift must never happen silently). Each migration is applied inside one
 * transaction together with its ledger row, so a half-applied migration can
 * never exist.
 *
 * Connection: migrations run against `DIRECT_URL` (direct, non-pooled,
 * transactional-DDL-safe), not `DATABASE_URL`.
 */

import { sql, type Kysely } from 'kysely';

import type { Logger } from '@slate/observability';

import { closeDatabase, createDatabase, type CreateDatabaseOptions } from './client.ts';
import { directDatabaseUrl } from './env.ts';
import { loadMigrations, type MigrationDefinition } from './migrations/index.ts';
import type { Database } from './types.ts';

/** Ledger table recording every applied migration. Part of `Database`. */
export const MIGRATIONS_LEDGER_TABLE = 'slate_migrations' as const;

/** Result of one runner pass. */
export interface MigrationRunResult {
  /** Ordinals applied by this pass, in order. */
  readonly applied: readonly string[];
  /** Ordinals found in the ledger and skipped by this pass. */
  readonly skipped: readonly string[];
}

/** Options accepted by {@link runMigrations}. */
export interface RunMigrationsOptions {
  /** Explicit migration list; defaults to `loadMigrations()`. */
  readonly migrations?: readonly MigrationDefinition[] | undefined;
  /** Optional logger; applied migrations are reported at `info`. */
  readonly logger?: Logger | undefined;
}

/**
 * Applies every pending migration inside the database/scheme `db` points at.
 *
 * @throws when an applied migration's checksum no longer matches its file, or
 *   when any statement fails (the transaction rolls back, nothing is applied).
 */
export async function runMigrations(
  db: Kysely<Database>,
  options: RunMigrationsOptions = {},
): Promise<MigrationRunResult> {
  const migrations = options.migrations ?? loadMigrations();

  await sql
    .raw(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_LEDGER_TABLE} (
    id text PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
)`,
    )
    .execute(db);

  const ledgerIds = new Set(
    (await db.selectFrom(MIGRATIONS_LEDGER_TABLE).select('id').execute()).map((row) => row.id),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    if (ledgerIds.has(migration.id)) {
      const recorded = await db
        .selectFrom(MIGRATIONS_LEDGER_TABLE)
        .select('checksum')
        .where('id', '=', migration.id)
        .executeTakeFirstOrThrow();
      if (recorded.checksum !== migration.checksum) {
        throw new Error(
          `[slate/database] migration ${migration.id} (${migration.name}) was modified after it was ` +
            `applied: recorded checksum does not match the file. Reverting applied migrations requires ` +
            `a new, explicitly-authored migration - never an in-place edit.`,
        );
      }
      skipped.push(migration.id);
      continue;
    }

    await db.transaction().execute(async (trx) => {
      for (const statement of migration.statements) {
        await sql.raw(statement).execute(trx);
      }
      await trx
        .insertInto(MIGRATIONS_LEDGER_TABLE)
        .values({
          id: migration.id,
          name: migration.name,
          checksum: migration.checksum,
        })
        .execute();
    });

    applied.push(migration.id);
    options.logger?.info('migration applied', {
      migrationId: migration.id,
      migration: migration.name,
    });
  }

  return { applied, skipped };
}

/** Options accepted by {@link runMigrationsFromEnv}. */
export interface RunMigrationsFromEnvOptions extends RunMigrationsOptions {
  /** Explicit connection string; defaults to `DIRECT_URL` read from `env`. */
  readonly url?: string | undefined;
  /** Environment map; defaults to `process.env`. */
  readonly env?: CreateDatabaseOptions['env'] | undefined;
}

/**
 * Runs the migrations against `DIRECT_URL` (or an explicit `url`) with a
 * dedicated, short-lived connection that is always closed afterwards.
 */
export async function runMigrationsFromEnv(
  options: RunMigrationsFromEnvOptions = {},
): Promise<MigrationRunResult> {
  const db = createDatabase({
    url: options.url ?? directDatabaseUrl(options.env),
    env: options.env,
    logger: options.logger,
  });
  try {
    return await runMigrations(db, { migrations: options.migrations, logger: options.logger });
  } finally {
    await closeDatabase(db);
  }
}
