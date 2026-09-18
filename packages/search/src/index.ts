/**
 * `@slate/search` — the tenant-isolated search abstraction (SLATE-208, ADR 007).
 *
 * ADR 007 selects PostgreSQL full-text search as the Phase 2 backend: the tenant
 * predicate lives in the same `WHERE` clause as the match, so isolation is a
 * property of the query itself rather than of a second service's configuration,
 * and no additional service has to be operated. `SearchEngine` is the seam that
 * keeps that decision replaceable — an external engine can be injected later
 * without the API routes ever learning about it.
 *
 * Every method takes the database (or transaction) as its first argument, the
 * same way `@slate/jobs` does: indexing is a mutation that must commit inside
 * the caller's transaction together with its audit row, and a query must observe
 * the same snapshot.
 */

import { sql, type Kysely } from 'kysely';

import { createTenantDatabase, type Database } from '@slate/database';

/** Longest accepted entity name; mirrors the `0009` CHECK. */
export const MAX_ENTITY_LENGTH = 64;
/** Longest accepted document title; mirrors the `0009` CHECK. */
export const MAX_TITLE_LENGTH = 255;
/** Longest accepted document body; mirrors the `0009` CHECK. */
export const MAX_BODY_LENGTH = 20_000;
/** Longest accepted query string. */
export const MAX_QUERY_LENGTH = 200;
/** Page-size bounds of the query contract. */
export const MIN_SEARCH_LIMIT = 1;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;

/** Dotted, namespaced entity (`docs.page`), like a job type but for documents. */
const ENTITY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** Platform ids are uuids; a document id is never a free-form path segment. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Input a caller can fix; the API maps it to a 400, never a 500. */
export class SearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchInputError';
  }
}

/** One document to index. The tenant scope is part of the call, not the record. */
export interface SearchDocument {
  readonly tenantId: string;
  readonly entity: string;
  /** Id of the row this text describes; re-indexing the same id replaces it. */
  readonly recordId: string;
  readonly title: string;
  readonly body: string;
}

/** A query result: enough to link back to the record, never the stored body. */
export interface SearchHit {
  readonly entity: string;
  readonly recordId: string;
  readonly title: string;
  /** `ts_rank` score; higher is more relevant, equal text ranks equal. */
  readonly rank: number;
}

/** What an accepted index call leaves behind. */
export interface IndexedDocument {
  readonly id: string;
  readonly entity: string;
  readonly recordId: string;
}

export interface SearchQuery {
  readonly tenantId: string;
  readonly entity: string;
  /** Free text. Always a bound parameter; never interpolated into SQL. */
  readonly q: string;
  readonly limit?: number | undefined;
}

/**
 * The search contract. `db` is a `Kysely<Database>` or one of its transactions —
 * passing the transaction is what lets the API index a document and write its
 * audit row atomically.
 */
export interface SearchEngine {
  index(db: Kysely<Database>, document: SearchDocument): Promise<IndexedDocument>;
  query(db: Kysely<Database>, input: SearchQuery): Promise<readonly SearchHit[]>;
}

/** Validates an entity name, or rejects the whole request. */
export function assertSearchEntity(entity: string): string {
  if (
    typeof entity !== 'string' ||
    !ENTITY_PATTERN.test(entity) ||
    entity.length > MAX_ENTITY_LENGTH
  ) {
    throw new SearchInputError(
      `"${entity.slice(0, 64)}" is not a valid entity: expected a dotted, namespaced name of at most ${MAX_ENTITY_LENGTH} characters.`,
    );
  }
  return entity;
}

/** Internal alias so every call site shares one validator. */
const assertEntity = assertSearchEntity;

/** Validates a document id; it becomes part of the unique record key. */
function assertRecordId(recordId: string): string {
  if (typeof recordId !== 'string' || !UUID_PATTERN.test(recordId)) {
    throw new SearchInputError(
      `"${recordId.slice(0, 64)}" is not a valid record id: expected a UUID.`,
    );
  }
  return recordId;
}

function assertTitle(title: string): string {
  if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE_LENGTH) {
    throw new SearchInputError(
      `title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters.`,
    );
  }
  return title;
}

function assertBody(body: string): string {
  if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH) {
    throw new SearchInputError(`body must be a string of at most ${MAX_BODY_LENGTH} characters.`);
  }
  return body;
}

function assertQueryText(q: string): string {
  if (typeof q !== 'string' || q.trim() === '' || q.length > MAX_QUERY_LENGTH) {
    throw new SearchInputError(
      `q must be a non-empty string of at most ${MAX_QUERY_LENGTH} characters.`,
    );
  }
  return q;
}

/** Validates the page size against the API contract bounds. */
export function resolveSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < MIN_SEARCH_LIMIT || limit > MAX_SEARCH_LIMIT) {
    throw new SearchInputError(
      `limit must be an integer in [${MIN_SEARCH_LIMIT}, ${MAX_SEARCH_LIMIT}].`,
    );
  }
  return limit;
}

/**
 * The PostgreSQL implementation (ADR 007).
 *
 * The `tsvector` lives in a generated column, so this class only ever writes
 * `title`/`body` and lets the database keep the index in step. Ranking is
 * `ts_rank`, and ties break on `record_id`, so the same data always answers in
 * the same order.
 */
export class PostgresSearchEngine implements SearchEngine {
  async index(db: Kysely<Database>, document: SearchDocument): Promise<IndexedDocument> {
    const entity = assertEntity(document.entity);
    const recordId = assertRecordId(document.recordId);
    const title = assertTitle(document.title);
    const body = assertBody(document.body);

    // One statement, so two concurrent indexers cannot both "insert then find
    // nothing": the unique (tenant_id, entity, record_id) index turns the loser
    // into an update. The generated vector is recomputed by the database.
    const row = await createTenantDatabase(db, document.tenantId)
      .insertInto('search_document', { entity, record_id: recordId, title, body })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'entity', 'record_id']).doUpdateSet({
          title,
          body,
          updated_at: sql<Date>`now()`,
        }),
      )
      .returning(['id', 'entity', 'record_id'])
      .executeTakeFirstOrThrow();

    return { id: row.id, entity: row.entity, recordId: row.record_id };
  }

  async query(db: Kysely<Database>, input: SearchQuery): Promise<readonly SearchHit[]> {
    const entity = assertEntity(input.entity);
    const q = assertQueryText(input.q);
    const limit = resolveSearchLimit(input.limit);

    // The scoped helper forces `tenant_id = $1`, so another tenant's documents
    // are not reachable here no matter what `q` contains.
    const rows = await createTenantDatabase(db, input.tenantId)
      .selectFrom('search_document')
      .select(['entity', 'record_id', 'title'])
      .select(sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${q}))`.as('rank'))
      .where(sql<boolean>`search_vector @@ plainto_tsquery('english', ${q})`)
      .where('entity', '=', entity)
      .orderBy('rank', 'desc')
      .orderBy('record_id', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      entity: row.entity,
      recordId: row.record_id,
      title: row.title,
      rank: row.rank,
    }));
  }
}

/** The engine the platform uses unless a host injects a different one. */
export const postgresSearchEngine: SearchEngine = new PostgresSearchEngine();
