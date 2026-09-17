import { describe, expect, it, vi } from 'vitest';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { Database } from '@slate/database';
import { createLogger } from '@slate/observability';
import { createApi, createEventBus } from './index.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const logger = createLogger({ env: { SLATE_ENV: 'test' }, sink: vi.fn() });
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
      const api = createApi({ db, logger, events: createEventBus(logger) });
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
      const api = createApi({ db, logger, events: createEventBus(logger) });
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
