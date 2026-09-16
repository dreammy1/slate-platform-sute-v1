import { describe, expect, it } from 'vitest';

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

import { TenantScopeError, assertTenantId, createTenantDatabase } from './tenant.ts';
import type { Database } from './types.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

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

describe('assertTenantId', () => {
  it('accepts canonical UUIDs and trims whitespace', () => {
    expect(assertTenantId(TENANT_A)).toBe(TENANT_A);
    expect(assertTenantId(`  ${TENANT_A}  `)).toBe(TENANT_A);
  });

  it('rejects empty, malformed and injection-shaped ids', () => {
    expect(() => assertTenantId('')).toThrow(TenantScopeError);
    expect(() => assertTenantId('not-a-uuid')).toThrow(/expected a UUID/);
    expect(() => assertTenantId(`${TENANT_A}; drop table audit_log`)).toThrow(TenantScopeError);
  });
});

describe('createTenantDatabase', () => {
  it('exposes the validated tenant id', () => {
    const scoped = createTenantDatabase(memoryDatabase(), TENANT_A);
    expect(scoped.tenantId).toBe(TENANT_A);
  });

  it('throws before any query is built when the tenant id is invalid', () => {
    expect(() => createTenantDatabase(memoryDatabase(), 'abc')).toThrow(TenantScopeError);
  });

  it('forces the tenant predicate on selects', () => {
    const scoped = createTenantDatabase(memoryDatabase(), TENANT_A);
    const compiled = scoped.selectFrom('audit_log').selectAll().compile();
    expect(compiled.sql).toContain('"tenant_id" = $1');
    expect(compiled.parameters[0]).toBe(TENANT_A);
  });

  it('keeps the caller predicate AND the tenant predicate', () => {
    const scoped = createTenantDatabase(memoryDatabase(), TENANT_A);
    const compiled = scoped
      .selectFrom('audit_log')
      .where('action', '=', 'user.created')
      .selectAll()
      .compile();
    expect(compiled.sql).toContain('"tenant_id" = $1');
    expect(compiled.sql).toContain('"action" = $2');
    expect(compiled.parameters[1]).toBe('user.created');
  });

  it('injects the scope tenant_id on inserts', () => {
    const scoped = createTenantDatabase(memoryDatabase(), TENANT_A);
    const compiled = scoped.insertInto('audit_log', { action: 'user.created' }).compile();
    expect(compiled.sql).toContain('insert into "audit_log"');
    expect(compiled.sql).toContain('"tenant_id"');
    expect(JSON.stringify(compiled.parameters)).toContain(TENANT_A);
  });

  it('rejects an insert that carries a foreign tenant_id', () => {
    const scoped = createTenantDatabase(memoryDatabase(), TENANT_A);
    expect(() =>
      scoped.insertInto('audit_log', {
        action: 'user.created',
        // The foreign id only reaches the helper through an untyped edge; the
        // runtime guard is the last line of defence (Master Plan Section 65).
        ...({ tenant_id: TENANT_B } as object),
      }),
    ).toThrow(TenantScopeError);
  });

  it('allows an insert that repeats the scope tenant_id', () => {
    const scoped = createTenantDatabase(memoryDatabase(), TENANT_A);
    expect(() =>
      scoped.insertInto('audit_log', {
        action: 'user.created',
        ...({ tenant_id: TENANT_A } as object),
      }),
    ).not.toThrow();
  });

  it('confines updates to the scope even without a caller predicate', () => {
    const scoped = createTenantDatabase(memoryDatabase(), TENANT_A);
    const compiled = scoped.updateTable('role').set({ name: 'admin' }).compile();
    expect(compiled.sql).toContain('"tenant_id" = $');
    expect(compiled.parameters).toContain(TENANT_A);
  });

  it('confines deletes to the scope even without a caller predicate', () => {
    const scoped = createTenantDatabase(memoryDatabase(), TENANT_B);
    const compiled = scoped.deleteFrom('permission').compile();
    expect(compiled.sql).toContain('delete from "permission"');
    expect(compiled.sql).toContain('"tenant_id" = $1');
    expect(compiled.parameters[0]).toBe(TENANT_B);
  });

  it('excludes cross-tenant tables from the scope (type level)', () => {
    const scoped = createTenantDatabase(memoryDatabase(), TENANT_A);
    // `organization` has no tenant_id column and must never be scoped.
    // @ts-expect-error - organization is not a TenantOwnedTable
    void scoped.selectFrom('organization');
    // `app_user` is global (membership links users to tenants).
    // @ts-expect-error - app_user is not a TenantOwnedTable
    void scoped.selectFrom('app_user');
    expect(true).toBe(true);
  });
});
