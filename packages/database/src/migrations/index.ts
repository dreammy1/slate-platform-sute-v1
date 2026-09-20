/**
 * Loads the raw SQL migrations in `src/migrations/`.
 *
 * Migrations stay as hand-written `.sql` files (auditable like the
 * `infrastructure/postgres/init/` bootstrap, ADR 001): no generated state, no
 * binary, no codegen. The loader reads the directory at runtime, validates the
 * file names against the `NNNN_name.sql` convention, splits every file into
 * statements on the `--> statement-breakpoint` marker, and computes a sha256
 * checksum per file so the runner can detect post-hoc edits to applied
 * migrations.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directory containing the raw `.sql` migration files (this directory).
 *
 * Resolved defensively. A bundler that inlines this module into a server bundle
 * (a Next.js app whose screens reach the database, for example) has no
 * `import.meta.url`, and a build must not fail merely for *importing* the
 * module: the value only matters when {@link loadMigrations} actually runs,
 * which requires the real Node module layout.
 */
function defaultMigrationsDirectory(): string {
  try {
    return fileURLToPath(new URL('.', import.meta.url));
  } catch {
    // Bundled or non-ESM context; `loadMigrations` is not supported there.
    return join(process.cwd(), 'src', 'migrations');
  }
}

export const MIGRATIONS_DIRECTORY = defaultMigrationsDirectory();

/** File-name convention: a four-digit ordinal, an underscore, a slug, `.sql`. */
export const MIGRATION_FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Separator between executable statements inside one migration file. */
export const STATEMENT_SEPARATOR = '--> statement-breakpoint';

/** A whole line that only contains the separator (mid-line mentions don't split). */
const STATEMENT_SEPARATOR_LINE = /^[ \t]*--> statement-breakpoint[ \t]*$/gm;

/** One discovered migration file, ready for the runner. */
export interface MigrationDefinition {
  /** Four-digit ordinal, e.g. `0001`. Order and ledger key. */
  readonly id: string;
  /** Slug from the file name, e.g. `organization_and_tenant`. */
  readonly name: string;
  /** Raw file content, checksum input exactly as authored. */
  readonly sql: string;
  /** Trimmed, non-empty statements in file order. */
  readonly statements: readonly string[];
  /** sha256 of the raw content; detects edits to applied migrations. */
  readonly checksum: string;
}

/** Splits raw SQL into executable statements on separator lines. */
export function splitStatements(sql: string): readonly string[] {
  return sql
    .split(STATEMENT_SEPARATOR_LINE)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

/** sha256 checksum of the raw migration content. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** Parses a file name into its ordinal and slug, or `undefined` when invalid. */
export function parseMigrationFileName(
  fileName: string,
): { readonly id: string; readonly name: string } | undefined {
  const match = MIGRATION_FILE_NAME.exec(fileName);
  const id = match?.[1];
  const name = match?.[2];
  return id === undefined || name === undefined ? undefined : { id, name };
}

/**
 * Discovers and validates every migration in `directory` (defaults to this
 * package's `src/migrations/`).
 *
 * @throws when a `.sql` file breaks the naming convention, when two files
 *   share an ordinal, or when a file contains no statements.
 */
export function loadMigrations(
  directory: string = MIGRATIONS_DIRECTORY,
): readonly MigrationDefinition[] {
  const migrations: MigrationDefinition[] = [];
  const seenIds = new Set<string>();

  for (const fileName of readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    const parsed = parseMigrationFileName(fileName);
    if (parsed === undefined) {
      throw new Error(
        `[slate/database] migration file "${fileName}" is invalid: expected the NNNN_name.sql convention.`,
      );
    }
    if (seenIds.has(parsed.id)) {
      throw new Error(`[slate/database] migration ordinal ${parsed.id} is used more than once.`);
    }
    seenIds.add(parsed.id);

    const sql = readFileSync(join(directory, fileName), 'utf8');
    const statements = splitStatements(sql);
    if (statements.length === 0) {
      throw new Error(`[slate/database] migration "${fileName}" contains no statements.`);
    }

    migrations.push({
      id: parsed.id,
      name: parsed.name,
      sql,
      statements,
      checksum: migrationChecksum(sql),
    });
  }

  return migrations;
}
