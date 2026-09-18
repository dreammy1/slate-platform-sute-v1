import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@slate/database';
import { TenantScopeError } from '@slate/database';

import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_QUERY_LENGTH,
  PostgresSearchEngine,
  SearchInputError,
  resolveSearchLimit,
} from './index.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const recordId = '33333333-3333-4333-8333-333333333333';

function database() {
  return new Kysely<Database>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

describe('resolveSearchLimit', () => {
  it('defaults and accepts the contract bounds', () => {
    expect(resolveSearchLimit(undefined)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(resolveSearchLimit(MAX_SEARCH_LIMIT)).toBe(MAX_SEARCH_LIMIT);
  });

  it('rejects anything outside the contract', () => {
    for (const limit of [0, -1, 1.5, MAX_SEARCH_LIMIT + 1, Number.NaN]) {
      expect(() => resolveSearchLimit(limit)).toThrow(SearchInputError);
    }
  });
});

describe('PostgresSearchEngine input validation', () => {
  it('rejects an invalid document before building any query', async () => {
    const db = database();
    const insertInto = vi.spyOn(db, 'insertInto');
    const engine = new PostgresSearchEngine();
    try {
      const documents = [
        { tenantId, entity: 'Not namespaced', recordId, title: 't', body: 'b' },
        { tenantId, entity: 'docs', recordId, title: 't', body: 'b' },
        { tenantId, entity: `${'a'.repeat(65)}`, recordId, title: 't', body: 'b' },
        { tenantId, entity: 'docs.page', recordId: 'not-a-uuid', title: 't', body: 'b' },
        { tenantId, entity: 'docs.page', recordId, title: '   ', body: 'b' },
        { tenantId, entity: 'docs.page', recordId, title: 't', body: 'b'.repeat(20_001) },
      ];
      for (const document of documents) {
        await expect(engine.index(db, document)).rejects.toBeInstanceOf(SearchInputError);
      }
      expect(insertInto).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });

  it('rejects an invalid query before building any query', async () => {
    const db = database();
    const selectFrom = vi.spyOn(db, 'selectFrom');
    const engine = new PostgresSearchEngine();
    try {
      const inputs = [
        { tenantId, entity: 'Not namespaced', q: 'quantum' },
        { tenantId, entity: 'docs.page', q: '' },
        { tenantId, entity: 'docs.page', q: '   ' },
        { tenantId, entity: 'docs.page', q: 'x'.repeat(MAX_QUERY_LENGTH + 1) },
        { tenantId, entity: 'docs.page', q: 'quantum', limit: 0 },
        { tenantId, entity: 'docs.page', q: 'quantum', limit: MAX_SEARCH_LIMIT + 1 },
      ];
      for (const input of inputs) {
        await expect(engine.query(db, input)).rejects.toBeInstanceOf(SearchInputError);
      }
      expect(selectFrom).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });

  it('leaves tenant scope to the database helper, which still rejects a foreign id', async () => {
    const db = database();
    const engine = new PostgresSearchEngine();
    try {
      // The tenant always arrives from the resolved context, so the engine never
      // validates it itself - but the scope it delegates to is still a guard.
      await expect(
        engine.query(db, { tenantId: 'not-a-uuid', entity: 'docs.page', q: 'quantum' }),
      ).rejects.toBeInstanceOf(TenantScopeError);
      await expect(
        engine.index(db, {
          tenantId: 'not-a-uuid',
          entity: 'docs.page',
          recordId,
          title: 't',
          body: 'b',
        }),
      ).rejects.toBeInstanceOf(TenantScopeError);
    } finally {
      await db.destroy();
    }
  });

  it('answers an empty page when the driver has no rows', async () => {
    const db = database();
    const engine = new PostgresSearchEngine();
    try {
      await expect(
        engine.query(db, { tenantId, entity: 'docs.page', q: 'quantum' }),
      ).resolves.toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});
