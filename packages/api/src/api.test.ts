import { describe, expect, it, vi } from 'vitest';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@slate/database';
import { FileSystemStorageProvider, MediaEngine } from '@slate/media';
import { createLogger } from '@slate/observability';
import { healthLive, healthReady } from './health.ts';
import { createApi, createEventBus } from './index.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const mediaRoot = mkdtempSync(join(tmpdir(), 'slate-media-'));
const logger = createLogger({ env: { SLATE_ENV: 'test' }, sink: vi.fn() });
/**
 * Storage is a required dependency of the API, exactly like the database, so
 * every scaffold here is built with a real (temp-directory-backed) engine.
 */
const mediaEngine = new MediaEngine(new FileSystemStorageProvider(mediaRoot), logger);

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
describe('API pre-query rejection', () => {
  it.each([
    { principal: undefined, requested: tenantId, status: 401 },
    {
      principal: { userId: 'user', tenantIds: [tenantId], activeTenantId: tenantId },
      requested: foreign,
      status: 403,
    },
    { principal: { userId: 'user', tenantIds: [tenantId] }, requested: 'malformed', status: 403 },
    {
      principal: { userId: '', tenantIds: [tenantId], activeTenantId: tenantId },
      requested: tenantId,
      status: 401,
    },
  ])(
    'rejects with $status before opening a transaction',
    async ({ principal, requested, status }) => {
      const db = database();
      const transaction = vi.spyOn(db, 'transaction');
      const api = createApi({ db, logger, events: createEventBus(logger), mediaEngine });
      try {
        expect(
          (await api({ method: 'GET', path: '/users', principal, tenantId: requested })).status,
        ).toBe(status);
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        await db.destroy();
      }
    },
  );
});
describe('configuration key rejection', () => {
  it.each([
    '/settings/%',
    '/features/%',
    '/settings/locale',
    `/settings/${'a'.repeat(300)}.value`,
    '/features/feature.undeclared',
  ])('returns 400 without opening a transaction for %s', async (path) => {
    const db = database();
    const transaction = vi.spyOn(db, 'transaction');
    try {
      const api = createApi({ db, logger, events: createEventBus(logger), mediaEngine });
      await expect(
        api({
          method: 'PUT',
          path,
          tenantId,
          principal: { userId: 'user', tenantIds: [tenantId], activeTenantId: tenantId },
          body: { value: true },
        }),
      ).resolves.toEqual({ status: 400, body: { error: 'Request rejected' } });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });
});

describe('event bus', () => {
  it('awaits subscribers, isolates failures and supports unsubscribe', async () => {
    const sink = vi.fn();
    const bus = createEventBus(createLogger({ env: { SLATE_ENV: 'test' }, sink }));
    const received: string[] = [];
    bus.subscribe('app.user.created', () => {
      throw new Error('private subscriber detail');
    });
    const unsubscribe = bus.subscribe('app.user.created', async (payload) => {
      await Promise.resolve();
      received.push(payload.userId);
    });
    const payload = { tenantId, userId: 'new', actorUserId: 'actor' };
    await bus.publish('app.user.created', payload);
    expect(received).toEqual(['new']);
    expect(JSON.stringify(sink.mock.calls)).not.toContain('private subscriber detail');
    unsubscribe();
    await bus.publish('app.user.created', payload);
    expect(received).toEqual(['new']);
  });
});

describe('search and health gates (SLATE-208)', () => {
  const principal = { userId: 'user', tenantIds: [tenantId], activeTenantId: tenantId };

  it('rejects an invalid search entity before opening a transaction', async () => {
    const db = database();
    const transaction = vi.spyOn(db, 'transaction');
    try {
      const api = createApi({ db, logger, events: createEventBus(logger), mediaEngine });
      for (const path of [
        '/search/Not%20namespaced',
        '/search/docs',
        `/search/${'a'.repeat(70)}`,
      ]) {
        await expect(
          api({ method: 'GET', path, tenantId, principal, query: { q: 'quantum' } }),
        ).resolves.toEqual({ status: 400, body: { error: 'Request rejected' } });
      }
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });

  it.each([
    { query: {}, description: 'a missing q' },
    { query: { q: '   ' }, description: 'a blank q' },
    { query: { q: 'x'.repeat(201) }, description: 'an over-long q' },
    { query: { q: 'quantum', limit: '0' }, description: 'a zero limit' },
    { query: { q: 'quantum', limit: '51' }, description: 'an over-large limit' },
    { query: { q: 'quantum', limit: 'soon' }, description: 'a non-numeric limit' },
  ])('rejects $description before opening a transaction', async ({ query }) => {
    const db = database();
    const transaction = vi.spyOn(db, 'transaction');
    try {
      const api = createApi({ db, logger, events: createEventBus(logger), mediaEngine });
      await expect(
        api({ method: 'GET', path: '/search/docs.page', tenantId, principal, query }),
      ).resolves.toEqual({ status: 400, body: { error: 'Request rejected' } });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });

  it('answers liveness without consulting any dependency', () => {
    expect(healthLive()).toEqual({ status: 200, body: { status: 'live' } });
  });

  it('reports readiness from the database and 503 without leaking the failure', async () => {
    const db = database();
    try {
      await expect(healthReady(db)).resolves.toEqual({ status: 200, body: { status: 'ready' } });
    } finally {
      await db.destroy();
    }
    const broken = {
      execute: vi.fn().mockRejectedValue(new Error('connection refused: host secret')),
    } as unknown as Kysely<Database>;
    await expect(healthReady(broken)).resolves.toEqual({
      status: 503,
      body: { status: 'unavailable' },
    });
  });
});
