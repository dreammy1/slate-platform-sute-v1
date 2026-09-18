import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, createDatabase, runMigrations, type Database } from '@slate/database';
import { FileSystemStorageProvider, MediaEngine } from '@slate/media';
import { createLogger } from '@slate/observability';
import { FEATURE_FLAG_KEYS } from '@slate/settings';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';

import { createApi } from './api.ts';
import { createEventBus } from './events.ts';

/** The four keys ADR 003 adds, seeded per tenant exactly like SLATE-202's. */
const CONFIGURATION_PERMISSIONS = [
  'settings.read',
  'settings.write',
  'features.read',
  'features.write',
] as const;

describe.skipIf(!integrationEnabled())('configuration routes (SLATE-204)', () => {
  let isolated: IsolatedDatabase;
  let db: Kysely<Database>;
  let tenantA: string;
  let tenantB: string;
  let adminId: string;
  let memberId: string;
  let adminRoleId: string;
  const logger = createLogger({ env: { SLATE_ENV: 'test' }, sink: vi.fn() });
  /** Storage is a required API dependency; these tests use a temp directory. */
  const mediaEngine = new MediaEngine(
    new FileSystemStorageProvider(mkdtempSync(join(tmpdir(), 'slate-media-'))),
    logger,
  );

  /** The configured principal for one of the two seeded users, in tenant A. */
  const principalFor = (userId: string) => ({
    userId,
    activeTenantId: tenantA,
    tenantIds: [tenantA],
  });

  /** Calls the pipeline as `userId` acts on `path` in tenant A. */
  const call = (
    userId: string,
    method: string,
    path: string,
    body?: unknown,
    tenantId: string = tenantA,
  ) =>
    createApi({ db, logger, events: createEventBus(logger), mediaEngine })({
      method,
      path,
      tenantId,
      principal: principalFor(userId),
      ...(body === undefined ? {} : { body }),
    });

  beforeAll(async () => {
    isolated = await createIsolatedDatabase({ schemaPrefix: 'slate_config' });
    db = createDatabase({
      url: isolated.url,
      searchPath: isolated.schema,
      env: { SLATE_ENV: 'test' },
      logger,
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

    const users = await db
      .insertInto('app_user')
      .values([
        { email: 'admin@example.test', display_name: 'Admin', password_hash: '' },
        { email: 'member@example.test', display_name: 'Member', password_hash: '' },
      ])
      .returning('id')
      .execute();
    adminId = users[0]!.id;
    memberId = users[1]!.id;

    // The admin holds every configuration permission; the member holds none, so
    // denial is exercised by a real membership rather than a missing one.
    const role = await db
      .insertInto('role')
      .values({ tenant_id: tenantA, name: 'config-admin' })
      .returning('id')
      .executeTakeFirstOrThrow();
    adminRoleId = role.id;
    await db
      .insertInto('tenant_membership')
      .values([
        { tenant_id: tenantA, app_user_id: adminId, role_id: adminRoleId },
        { tenant_id: tenantA, app_user_id: memberId, role_id: null },
      ])
      .execute();

    for (const key of CONFIGURATION_PERMISSIONS) {
      const permission = await db
        .insertInto('permission')
        .values({ tenant_id: tenantA, key })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('role_permission')
        .values({ role_id: adminRoleId, permission_id: permission.id })
        .execute();
    }
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
    if (isolated) await isolated.dispose();
  });

  describe('PUT /settings/:key', () => {
    it('round-trips every supported value type through write and read', async () => {
      const cases = [
        ['branding.locale', 'en-GB', 'string'],
        ['pricing.tax_rate', 19.5, 'number'],
        ['booking.require_deposit', true, 'boolean'],
        ['branding.theme', { accent: '#0af', dark: false }, 'json'],
      ] as const;

      for (const [key, value, valueType] of cases) {
        const written = await call(adminId, 'PUT', `/settings/${key}`, { value });
        expect(written).toEqual({ status: 200, body: { setting: { key, value, valueType } } });
      }

      const listed = await call(adminId, 'GET', '/settings');
      expect(listed.status).toBe(200);
      const settings = (listed.body as { settings: unknown[] }).settings;
      expect(settings).toHaveLength(cases.length);
      for (const [key, value, valueType] of cases) {
        const stored = (settings as { key: string; value: unknown; valueType: string }[]).find(
          (row) => row.key === key,
        );
        expect(stored).toStrictEqual({ key, value, valueType });
      }
    });

    it('commits exactly one attributed audit row, and publishes only after the commit', async () => {
      const bus = createEventBus(logger);
      const delivered: { key: string; visibleAtDelivery: boolean }[] = [];
      bus.subscribe('settings.updated', async (payload) => {
        // Read through a second connection: had the event been published before
        // COMMIT, the row would not be visible here yet.
        const row = await db
          .selectFrom('system_setting')
          .select('key')
          .where('tenant_id', '=', payload.tenantId)
          .where('key', '=', payload.key)
          .executeTakeFirst();
        delivered.push({ key: payload.key, visibleAtDelivery: row !== undefined });
      });

      const response = await createApi({ db, logger, events: bus, mediaEngine })({
        method: 'PUT',
        path: '/settings/branding.currency',
        tenantId: tenantA,
        principal: principalFor(adminId),
        body: { value: 'GBP' },
      });

      expect(response).toMatchObject({ status: 200 });
      expect(delivered).toEqual([{ key: 'branding.currency', visibleAtDelivery: true }]);

      const audits = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'settings.updated')
        .where('resource_id', '=', 'branding.currency')
        .execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        tenant_id: tenantA,
        actor_user_id: adminId,
        resource_type: 'system_setting',
      });
      // Section 61: neither the audit payload nor the event may carry the value.
      expect(JSON.stringify(audits[0]!.payload)).not.toContain('GBP');
      expect(JSON.stringify(delivered)).not.toContain('GBP');
    });

    it('rejects an invalid key, an unknown field and an unstorable value without writing', async () => {
      const settingsBefore = await db
        .selectFrom('system_setting')
        .selectAll()
        .orderBy('id')
        .execute();
      const auditsBefore = await db.selectFrom('audit_log').selectAll().orderBy('id').execute();
      const rejected = [
        ['/settings/locale', { value: 'en-GB' }],
        ['/settings/branding.locale', { value: 'en-GB', tenant_id: tenantB }],
        ['/settings/branding.items', { value: { items: [new Date()] } }],
        ['/settings/branding.theme', { value: { at: new Date() } }],
        ['/settings/branding.locale', {}],
      ] as const;

      for (const [path, body] of rejected) {
        expect((await call(adminId, 'PUT', path, body)).status).toBe(400);
      }
      expect(await db.selectFrom('system_setting').selectAll().orderBy('id').execute()).toEqual(
        settingsBefore,
      );
      expect(await db.selectFrom('audit_log').selectAll().orderBy('id').execute()).toEqual(
        auditsBefore,
      );
    });
  });
  describe('feature flags', () => {
    it('returns every declared flag at its registry default, and nothing else', async () => {
      const response = await call(adminId, 'GET', '/features');
      expect(response.status).toBe(200);
      const features = (response.body as { features: Record<string, boolean> }).features;
      expect(Object.keys(features).sort()).toEqual([...FEATURE_FLAG_KEYS].sort());
      expect(features['feature.restaurant.v1']).toBe(false);
      expect(features['feature.new-checkout']).toBe(false);
    });

    it('overrides a flag, then clears the override back to the registry default', async () => {
      const enabled = await call(adminId, 'PUT', '/features/feature.new-checkout', {
        enabled: true,
      });
      expect(enabled).toEqual({
        status: 200,
        body: { key: 'feature.new-checkout', enabled: true },
      });
      const afterOverride = await call(adminId, 'GET', '/features');
      expect(
        (afterOverride.body as { features: Record<string, boolean> }).features[
          'feature.new-checkout'
        ],
      ).toBe(true);

      // `null` removes the override, so the tenant reverts to the default.
      const cleared = await call(adminId, 'PUT', '/features/feature.new-checkout', {
        enabled: null,
      });
      expect(cleared).toEqual({
        status: 200,
        body: { key: 'feature.new-checkout', enabled: false },
      });
      const afterClear = await call(adminId, 'GET', '/features');
      expect(
        (afterClear.body as { features: Record<string, boolean> }).features['feature.new-checkout'],
      ).toBe(false);
      expect(await db.selectFrom('feature_flag').selectAll().execute()).toEqual([]);
    });

    it('audits and publishes an accepted flag write, with the key but never the state', async () => {
      const bus = createEventBus(logger);
      const delivered: { key: string; enabled: boolean }[] = [];
      bus.subscribe('feature.flag.updated', async (payload) => {
        const row = await db
          .selectFrom('feature_flag')
          .select('enabled')
          .where('tenant_id', '=', payload.tenantId)
          .where('key', '=', payload.key)
          .executeTakeFirst();
        delivered.push({ key: payload.key, enabled: row?.enabled ?? false });
      });

      const response = await createApi({ db, logger, events: bus, mediaEngine })({
        method: 'PUT',
        path: '/features/feature.ai.assistant',
        tenantId: tenantA,
        principal: principalFor(adminId),
        body: { enabled: true },
      });
      expect(response).toMatchObject({ status: 200 });
      expect(delivered).toEqual([{ key: 'feature.ai.assistant', enabled: true }]);

      const audits = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'feature.flag.updated')
        .where('resource_id', '=', 'feature.ai.assistant')
        .execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        tenant_id: tenantA,
        actor_user_id: adminId,
        resource_type: 'feature_flag',
      });
      // Section 61: the audit payload carries the key, never the resolved state.
      expect(audits[0]!.payload).toEqual({ key: 'feature.ai.assistant' });
    });

    it('refuses an undeclared flag key, and never surfaces a stray override', async () => {
      expect(
        (await call(adminId, 'PUT', '/features/feature.undeclared', { enabled: true })).status,
      ).toBe(400);

      // A row written outside the API must stay invisible: resolution fails
      // closed for a key nobody declared (Section 60).
      await db
        .insertInto('feature_flag')
        .values({ tenant_id: tenantA, key: 'feature.undeclared', enabled: true })
        .execute();
      const response = await call(adminId, 'GET', '/features');
      const features = (response.body as { features: Record<string, boolean> }).features;
      expect(features['feature.undeclared']).toBeUndefined();
      expect(Object.keys(features).sort()).toEqual([...FEATURE_FLAG_KEYS].sort());
      await db.deleteFrom('feature_flag').where('key', '=', 'feature.undeclared').execute();
    });
  });

  describe('write rollback', () => {
    it('rolls the setting write back when the mandatory audit insert fails', async () => {
      const bus = createEventBus(logger);
      const publish = vi.spyOn(bus, 'publish');
      // Test-only constraint in this isolated schema: it fails the audit insert
      // rather than the write before it, so what removes the setting row can
      // only be the rollback (Section 57).
      await sql`alter table audit_log add constraint test_reject_settings_audit check (action <> 'settings.updated') not valid`.execute(
        db,
      );
      try {
        const result = await createApi({ db, logger, events: bus, mediaEngine })({
          method: 'PUT',
          path: '/settings/rollback.probe',
          tenantId: tenantA,
          principal: principalFor(adminId),
          body: { value: 'x' },
        });
        expect(result).toEqual({ status: 500, body: { error: 'Internal server error' } });
        expect(
          await db
            .selectFrom('system_setting')
            .select('key')
            .where('key', '=', 'rollback.probe')
            .execute(),
        ).toEqual([]);
        // A rolled-back write must never announce itself.
        expect(publish).not.toHaveBeenCalled();
      } finally {
        await sql`alter table audit_log drop constraint test_reject_settings_audit`.execute(db);
      }
    });
  });
});
