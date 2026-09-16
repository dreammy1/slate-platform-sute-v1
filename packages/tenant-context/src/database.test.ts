import { describe, expect, it } from 'vitest';

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

import type { LogFields } from '@slate/observability';

import { createLogger } from '@slate/observability';

import { closeDatabase } from '@slate/database';

import { createRequestDatabase, tenantDatabaseFor } from './database.ts';
import type { TenantContext } from './context.ts';

import { emitTenantSelected, TENANT_SELECTED_EVENT } from './events.ts';

import type { Database } from '@slate/database';

const TENANT_A = '11111111-1111-4111-8111-111111111111';

const SCHEMA = 'slate_tenant_ctx_test';

const CONTEXT: TenantContext = { tenantId: TENANT_A };

const CONNECTION_STRING =
  'postgresql://slate:slate_dev_password@localhost:5432/slate?schema=public';

/** Kysely over DummyDriver: queries compile (and can be asserted) with no I/O. */
function memoryDatabase(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function captureLogger(): { records: LogFields[]; logger: ReturnType<typeof createLogger> } {
  const records: LogFields[] = [];
  const logger = createLogger({
    env: { SLATE_ENV: 'test', LOG_LEVEL: 'debug' },
    sink: (_line, record) => {
      records.push(record);
    },
  });
  return { records, logger };
}

describe('tenantDatabaseFor', () => {
  it('injects the resolved tenant into the scoped helper', () => {
    const scoped = tenantDatabaseFor(memoryDatabase(), CONTEXT);
    expect(scoped.tenantId).toBe(TENANT_A);

    const compiled = scoped.selectFrom('audit_log').selectAll().compile();
    expect(compiled.sql).toContain('"tenant_id" = $1');
    expect(compiled.parameters[0]).toBe(TENANT_A);
  });

  it('rejects a context without a tenant id', () => {
    expect(() => tenantDatabaseFor(memoryDatabase(), { tenantId: '   ' })).toThrow(
      /\[slate\/tenant-context\]/,
    );
  });
});

describe('createRequestDatabase', () => {
  it('builds a client with the request bindings and closes it without connecting', async () => {
    const { logger } = captureLogger();
    const db = createRequestDatabase({
      url: CONNECTION_STRING,
      schema: SCHEMA,
      context: CONTEXT,
      requestId: 'req-1',
      logger,
      env: { SLATE_ENV: 'test' },
    });
    expect(db).toBeInstanceOf(Kysely);
    await closeDatabase(db);
  });

  it('rejects an invalid search_path schema', () => {
    expect(() =>
      createRequestDatabase({
        url: CONNECTION_STRING,
        schema: 'public; drop schema public',
        context: CONTEXT,
        env: { SLATE_ENV: 'test' },
      }),
    ).toThrow(/\[slate\/database\]/);
  });
});

describe('emitTenantSelected', () => {
  it('emits the event at info with tenantId and organizationId', () => {
    const { records, logger } = captureLogger();
    emitTenantSelected(logger, {
      tenantId: TENANT_A,
      organizationId: '55555555-5555-4555-8555-555555555555',
      requestId: 'req-2',
    });

    expect(records).toHaveLength(1);
    const record = records[0] as LogFields;
    expect(record.level).toBe('info');
    expect(record.msg).toBe(TENANT_SELECTED_EVENT);
    expect(record['event']).toBe(TENANT_SELECTED_EVENT);
    expect(record['tenantId']).toBe(TENANT_A);
    expect(record['organizationId']).toBe('55555555-5555-4555-8555-555555555555');
    expect(record['requestId']).toBe('req-2');
  });

  it('omits the requestId binding when there is none', () => {
    const { records, logger } = captureLogger();
    emitTenantSelected(logger, {
      tenantId: TENANT_A,
      organizationId: '55555555-5555-4555-8555-555555555555',
    });
    const record = records[0] as LogFields;
    expect('requestId' in record).toBe(false);
  });

  it('refuses to emit without both ids', () => {
    const { records, logger } = captureLogger();
    expect(() =>
      emitTenantSelected(logger, {
        tenantId: '  ',
        organizationId: '55555555-5555-4555-8555-555555555555',
      }),
    ).toThrow(/requires both/);
    expect(records).toHaveLength(0);
  });
});
