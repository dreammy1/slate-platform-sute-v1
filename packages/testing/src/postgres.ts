import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { requireTestDatabaseUrl } from './env.ts';

/** PostgreSQL truncates identifiers at 63 bytes. */
const MAX_IDENTIFIER_LENGTH = 63;

/** Random suffix length, keeping generated schema names collision-free. */
const UNIQUE_SUFFIX_LENGTH = 12;

/** Default prefix for generated test schemas. */
export const DEFAULT_SCHEMA_PREFIX = 'slate_test';

/** Schema name accepted by {@link assertValidSchemaName}. */
const SAFE_SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Guards every identifier that ends up in raw SQL. Schema names are generated
 * by this package, but they can also be passed in by callers, so they are
 * validated (never interpolated blindly) before interpolation.
 */
export function assertValidSchemaName(name: string): string {
  if (!SAFE_SCHEMA_NAME.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(
      `[slate/testing] "${name}" is not a valid test schema name: expected /${SAFE_SCHEMA_NAME.source}/ with at most ${MAX_IDENTIFIER_LENGTH} characters.`,
    );
  }
  return name;
}

/**
 * Builds a unique, lowercase schema name such as
 * `slate_booking_9f4c1d2e7a05`. `public` is never generated, so test suites can
 * never accidentally reuse or drop the database's default schema.
 */
export function generateSchemaName(prefix: string = DEFAULT_SCHEMA_PREFIX): string {
  const normalized = prefix
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = normalized === '' ? DEFAULT_SCHEMA_PREFIX : normalized;
  const suffix = randomUUID().replaceAll('-', '').slice(0, UNIQUE_SUFFIX_LENGTH);
  const trimmedBase = base.slice(0, MAX_IDENTIFIER_LENGTH - UNIQUE_SUFFIX_LENGTH - 1);

  return `${trimmedBase}_${suffix}`;
}

/**
 * Opens a client whose `search_path` points at `schema`, so unqualified DDL and
 * DML in the suite never touches `public` (or another suite's objects).
 */
export async function connectWithSchema(url: string, schema: string): Promise<Client> {
  const client = new Client({
    connectionString: url,
    options: `-c search_path=${assertValidSchemaName(schema)}`,
  });
  await client.connect();
  return client;
}

/** Drops a test schema and everything inside it. Idempotent. */
export async function dropSchema(url: string, schema: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(assertValidSchemaName(schema))} CASCADE`,
    );
  } finally {
    await client.end();
  }
}

export interface IsolatedDatabaseOptions {
  /**
   * Prefix for the generated schema, normally the domain under test
   * (`slate_booking`, `slate_crm`, ...).
   */
  readonly schemaPrefix?: string | undefined;
  /**
   * Runs inside the new schema, on a client scoped to it. This is where a suite
   * applies migrations or fixtures, so its objects exist only in its own schema.
   */
  readonly setup?: ((client: Client) => Promise<void>) | undefined;
}

export interface IsolatedDatabase {
  /** Unique schema owned by the suite. */
  readonly schema: string;
  /** Connection string the schema was created in. */
  readonly url: string;
  /** Opens an additional client scoped to {@link schema}. */
  createClient: () => Promise<Client>;
  /** Drops the schema (cascade) — safe to call more than once. */
  dispose: () => Promise<void>;
}

/**
 * Creates a PostgreSQL schema dedicated to one integration suite.
 *
 * Every suite gets its own schema inside the database referenced by
 * `TEST_DATABASE_URL`, which is why suites can run in parallel and why a suite
 * can be replayed in isolation: two suites never see each other's tables, and
 * `public` is never touched. `dispose()` removes the schema again.
 *
 * @example
 * ```ts
 * const database = await createIsolatedDatabase({ schemaPrefix: 'slate_crm' });
 * const client = await database.createClient();
 * // ... assertions against client
 * await client.end();
 * await database.dispose();
 * ```
 */
export async function createIsolatedDatabase(
  options: IsolatedDatabaseOptions = {},
): Promise<IsolatedDatabase> {
  const url = requireTestDatabaseUrl();
  const schema = generateSchemaName(options.schemaPrefix);
  const admin = new Client({ connectionString: url });
  await admin.connect();

  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);

    if (options.setup !== undefined) {
      const client = await connectWithSchema(url, schema);
      try {
        await options.setup(client);
      } finally {
        await client.end();
      }
    }
  } catch (error) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    throw error;
  } finally {
    await admin.end();
  }

  return {
    schema,
    url,
    createClient: () => connectWithSchema(url, schema),
    dispose: () => dropSchema(url, schema),
  };
}

/**
 * {@link createIsolatedDatabase} with guaranteed teardown, for suites that only
 * need the database for the duration of one call.
 */
export async function withIsolatedDatabase<T>(
  run: (database: IsolatedDatabase) => Promise<T>,
  options: IsolatedDatabaseOptions = {},
): Promise<T> {
  const database = await createIsolatedDatabase(options);
  try {
    return await run(database);
  } finally {
    await database.dispose();
  }
}
