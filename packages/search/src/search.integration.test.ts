import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, createDatabase, runMigrations, type Database } from '@slate/database';
import { createLogger } from '@slate/observability';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';

import { PostgresSearchEngine } from './index.ts';

const logger = createLogger({ env: { SLATE_ENV: 'test' }, sink: () => undefined });
const engine = new PostgresSearchEngine();
const entity = 'docs.page';

/**
 * `@slate/search` (SLATE-208) against real PostgreSQL.
 *
 * ADR 007's decision lives or dies here: the match and the tenant predicate must
 * be the same query, ranking must be stable, and the query text must always be a
 * bound parameter. The generated `search_vector` column is what keeps the index
 * in step with the text, which the re-index assertions pin down.
 */
describe.skipIf(!integrationEnabled())('@slate/search (integration)', () => {
  let isolated: IsolatedDatabase;
  let db: Kysely<Database>;
  let tenantA = '';
  let tenantB = '';

  beforeAll(async () => {
    isolated = await createIsolatedDatabase({ schemaPrefix: 'slate_search' });
    db = createDatabase({
      url: isolated.url,
      searchPath: isolated.schema,
      env: { SLATE_ENV: 'test' },
      logger,
      omitQueryParameters: true,
    });
    await runMigrations(db);

    const org = await db
      .insertInto('organization')
      .values({ name: 'Acme', slug: 'acme' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const tenants = await db
      .insertInto('tenant')
      .values([
        { organization_id: org.id, name: 'A', slug: 'a' },
        { organization_id: org.id, name: 'B', slug: 'b' },
      ])
      .returning('id')
      .execute();
    tenantA = tenants[0]!.id;
    tenantB = tenants[1]!.id;
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
    if (isolated) await isolated.dispose();
  });

  /** Deterministic record ids: `00000000-0000-4000-8000-00000000000N`. */
  const recordIdFor = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

  const documentCount = async () =>
    (await db.selectFrom('search_document').select('id').execute()).length;

  it('indexes, re-indexes in place and answers a ranked query', async () => {
    const first = await engine.index(db, {
      tenantId: tenantA,
      entity,
      recordId: recordIdFor(1),
      title: 'Quantum computing',
      body: 'Entanglement and superposition.',
    });
    expect(first.recordId).toBe(recordIdFor(1));

    // Re-indexing the same record replaces its text instead of duplicating it.
    const again = await engine.index(db, {
      tenantId: tenantA,
      entity,
      recordId: recordIdFor(1),
      title: 'Quantum computing, second edition',
      body: 'Entanglement, superposition and error correction.',
    });
    expect(again.id).toBe(first.id);
    expect(
      await db
        .selectFrom('search_document')
        .select('id')
        .where('record_id', '=', recordIdFor(1))
        .execute(),
    ).toHaveLength(1);

    const hits = await engine.query(db, { tenantId: tenantA, entity, q: 'quantum' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      entity,
      recordId: recordIdFor(1),
      title: 'Quantum computing, second edition',
    });
    expect(hits[0]?.rank).toBeGreaterThan(0);
  });

  it('hides one tenant\u2019s documents from another, even for the same record id', async () => {
    expect(await engine.query(db, { tenantId: tenantB, entity, q: 'quantum' })).toEqual([]);

    // Tenant B indexes its own copy of the same record id: the unique key is
    // (tenant_id, entity, record_id), so this is a second document, not an
    // overwrite of tenant A's.
    await engine.index(db, {
      tenantId: tenantB,
      entity,
      recordId: recordIdFor(1),
      title: 'Quantum notes',
      body: 'A different tenant, the same record id.',
    });

    expect(await engine.query(db, { tenantId: tenantA, entity, q: 'quantum' })).toHaveLength(1);
    expect(await engine.query(db, { tenantId: tenantB, entity, q: 'quantum' })).toHaveLength(1);
    expect(
      await db
        .selectFrom('search_document')
        .selectAll()
        .where('record_id', '=', recordIdFor(1))
        .execute(),
    ).toHaveLength(2);
  });

  it('ranks equal documents deterministically and by relevance', async () => {
    for (const n of [2, 3]) {
      await engine.index(db, {
        tenantId: tenantA,
        entity,
        recordId: recordIdFor(n),
        title: 'Alpha beta',
        body: 'Alpha beta gamma.',
      });
    }

    const first = await engine.query(db, { tenantId: tenantA, entity, q: 'alpha beta' });
    expect(first.map((hit) => hit.recordId)).toEqual([recordIdFor(2), recordIdFor(3)]);
    // The same data answers in the same order on every call.
    const second = await engine.query(db, { tenantId: tenantA, entity, q: 'alpha beta' });
    expect(second.map((hit) => hit.recordId)).toEqual(first.map((hit) => hit.recordId));

    // More occurrences of the term rank higher (ts_rank term frequency).
    await engine.index(db, {
      tenantId: tenantA,
      entity,
      recordId: recordIdFor(4),
      title: 'Alpha alpha alpha',
      body: 'Alpha alpha.',
    });
    const ranked = await engine.query(db, { tenantId: tenantA, entity, q: 'alpha' });
    expect(ranked[0]?.recordId).toBe(recordIdFor(4));
  });

  it('honours the limit, the entity scope and treats query text as data', async () => {
    const page = await engine.query(db, { tenantId: tenantA, entity, q: 'alpha', limit: 2 });
    expect(page).toHaveLength(2);

    // A different entity never answers for another entity's text.
    expect(await engine.query(db, { tenantId: tenantA, entity: 'docs.note', q: 'alpha' })).toEqual(
      [],
    );

    // The query string is a bound parameter: metacharacters are data, not SQL.
    const before = await documentCount();
    await expect(
      engine.query(db, { tenantId: tenantA, entity, q: `alpha'; DROP TABLE search_document; --` }),
    ).resolves.toEqual([]);
    expect(await documentCount()).toBe(before);
  });
});
