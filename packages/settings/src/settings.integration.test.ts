/**
 * `@slate/settings` against a real PostgreSQL schema.
 *
 * The unit suite proves the semantic layer against a fake; this suite proves the
 * things only a database can: that a `jsonb` value round-trips with its type,
 * that SLATE-200's scoped helper really hides another tenant's rows, and that a
 * configuration write and its `audit_log` row commit or roll back together.
 *
 * Every suite gets its own schema (`createIsolatedDatabase`), so nothing here
 * touches `public` or another suite's tables.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, createDatabase, runMigrations, type Database } from '@slate/database';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';

import { createTenantConfiguration, type TenantConfiguration } from './database.ts';

describe.skipIf(!integrationEnabled())('@slate/settings (integration)', () => {
  let isolated: IsolatedDatabase | undefined;
  let db: Kysely<Database> | undefined;
  let tenantA = '';
  let tenantB = '';
  let actorId = '';
  let configuration: TenantConfiguration;

  beforeAll(async () => {
    isolated = await createIsolatedDatabase({ schemaPrefix: 'slate_settings' });
    const client = createDatabase({
      url: isolated.url,
      searchPath: isolated.schema,
      env: { SLATE_ENV: 'test' },
    });
    db = client;
    await runMigrations(client);

    const organization = await client
      .insertInto('organization')
      .values({ name: 'Acme Inc', slug: 'acme' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const tenants = await client
      .insertInto('tenant')
      .values([
        { organization_id: organization.id, name: 'Tenant A', slug: 'tenant-a' },
        { organization_id: organization.id, name: 'Tenant B', slug: 'tenant-b' },
      ])
      .returning('id')
      .execute();
    const tenantARow = tenants[0];
    const tenantBRow = tenants[1];
    if (tenantARow === undefined || tenantBRow === undefined) {
      throw new Error('[slate/settings] seeding tenants failed.');
    }
    tenantA = tenantARow.id;
    tenantB = tenantBRow.id;

    const actor = await client
      .insertInto('app_user')
      .values({ email: 'admin@example.test', display_name: 'Admin', password_hash: '' })
      .returning('id')
      .executeTakeFirstOrThrow();
    actorId = actor.id;

    configuration = createTenantConfiguration(client);
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
    if (isolated) await isolated.dispose();
  });
  describe('type-preserving round trip through jsonb', () => {
    it.each([
      ['branding.locale', 'en-GB', 'string'],
      ['pricing.tax_rate', 19.5, 'number'],
      ['booking.require_deposit', true, 'boolean'],
      ['branding.theme', { accent: '#0af', dark: false }, 'json'],
      ['search.facets', ['crm', 'booking'], 'json'],
      ['booking.limits', { perDay: 12, days: { mon: 3 } }, 'json'],
    ])('reads %s back as it was written', async (key, value, valueType) => {
      const saved = await configuration.settings.setSetting({ tenantId: tenantA, key, value });
      expect(saved).toStrictEqual({ key, value, valueType });

      // A second read goes to the database, not to the object just returned.
      const read = await configuration.settings.getSetting({ tenantId: tenantA, key });
      expect(read?.value).toStrictEqual(value);
      expect(read?.valueType).toBe(valueType);
      expect(typeof read?.value).toBe(typeof value);
    });

    it('stores a string as JSON text so jsonb accepts it', async () => {
      if (!db) throw new Error('[slate/settings] database was not initialised.');
      await configuration.settings.setSetting({
        tenantId: tenantA,
        key: 'branding.locale',
        value: 'en-GB',
      });
      const row = await db
        .selectFrom('system_setting')
        .select('value')
        .where('tenant_id', '=', tenantA)
        .where('key', '=', 'branding.locale')
        .executeTakeFirstOrThrow();
      // A bare `en-GB` would have been rejected as invalid JSON on insert.
      expect(row.value).toBe('en-GB');
      expect(
        await sql<{ j: string }>`select value #>> '{}' as j from system_setting
          where tenant_id = ${tenantA} and key = 'branding.locale'`.execute(db),
      ).toMatchObject({ rows: [{ j: 'en-GB' }] });
    });
  });

  describe('tenant isolation', () => {
    it('keeps one tenant from reading, listing or updating another tenant setting', async () => {
      await configuration.settings.setSetting({
        tenantId: tenantA,
        key: 'branding.locale',
        value: 'en-GB',
      });
      await configuration.settings.setSetting({
        tenantId: tenantB,
        key: 'branding.locale',
        value: 'fr-FR',
      });

      expect(
        (await configuration.settings.getSetting({ tenantId: tenantA, key: 'branding.locale' }))
          ?.value,
      ).toBe('en-GB');
      expect(
        (await configuration.settings.getSetting({ tenantId: tenantB, key: 'branding.locale' }))
          ?.value,
      ).toBe('fr-FR');

      // A write for B must not have touched A's row, and vice versa.
      await configuration.settings.setSetting({
        tenantId: tenantA,
        key: 'branding.locale',
        value: 'de-DE',
      });
      expect(
        (await configuration.settings.getSetting({ tenantId: tenantB, key: 'branding.locale' }))
          ?.value,
      ).toBe('fr-FR');

      // `listSettings` returns everything tenant A has configured, so this
      // asserts A's own row rather than a whole-tenant count. The negative case
      // (a key that exists only for B) is the next test's subject.
      const listA = await configuration.settings.listSettings({ tenantId: tenantA });
      const localeA = listA.find((setting) => setting.key === 'branding.locale');
      expect(localeA?.value).toBe('de-DE');
      expect(localeA?.valueType).toBe('string');
    });

    it('never returns a key that exists only in the other tenant', async () => {
      await configuration.settings.setSetting({
        tenantId: tenantA,
        key: 'pricing.tax_rate',
        value: 19.5,
      });
      expect(
        await configuration.settings.getSetting({ tenantId: tenantB, key: 'pricing.tax_rate' }),
      ).toBeNull();
      const listB = await configuration.settings.listSettings({ tenantId: tenantB });
      expect(listB.map((setting) => setting.key)).not.toContain('pricing.tax_rate');
    });

    it('deletes only the addressed tenant row', async () => {
      await configuration.settings.setSetting({
        tenantId: tenantA,
        key: 'booking.team_size',
        value: 8,
      });
      await configuration.settings.setSetting({
        tenantId: tenantB,
        key: 'booking.team_size',
        value: 3,
      });
      await configuration.settings.clearSetting({ tenantId: tenantA, key: 'booking.team_size' });

      expect(
        await configuration.settings.getSetting({ tenantId: tenantA, key: 'booking.team_size' }),
      ).toBeNull();
      expect(
        (await configuration.settings.getSetting({ tenantId: tenantB, key: 'booking.team_size' }))
          ?.value,
      ).toBe(3);
    });

    it('refuses a malformed tenant id instead of querying', async () => {
      await expect(configuration.settings.listSettings({ tenantId: 'not-a-uuid' })).rejects.toThrow(
        /not a valid tenant id/,
      );
    });
  });

  describe('upsert semantics', () => {
    it('replaces instead of duplicating when the same key is written twice', async () => {
      if (!db) throw new Error('[slate/settings] database was not initialised.');
      await configuration.settings.setSetting({
        tenantId: tenantA,
        key: 'branding.logo',
        value: 'one.svg',
      });
      await configuration.settings.setSetting({
        tenantId: tenantA,
        key: 'branding.logo',
        value: 'two.svg',
      });
      const rows = await db
        .selectFrom('system_setting')
        .select(['key', 'value'])
        .where('tenant_id', '=', tenantA)
        .where('key', '=', 'branding.logo')
        .execute();
      expect(rows).toEqual([{ key: 'branding.logo', value: 'two.svg' }]);
    });
  });

  describe('feature flag overrides', () => {
    it('resolves the registry default until the tenant overrides it', async () => {
      const before = await configuration.flags.resolveFeatureFlag({
        tenantId: tenantA,
        key: 'feature.restaurant.v1',
      });
      expect(before).toEqual({
        key: 'feature.restaurant.v1',
        enabled: false,
        source: 'registry-default',
      });

      const enabled = await configuration.flags.setFeatureFlag({
        tenantId: tenantA,
        key: 'feature.restaurant.v1',
        enabled: true,
      });
      expect(enabled).toEqual({
        key: 'feature.restaurant.v1',
        enabled: true,
        source: 'override',
      });

      const cleared = await configuration.flags.clearFeatureFlag({
        tenantId: tenantA,
        key: 'feature.restaurant.v1',
      });
      expect(cleared).toEqual({
        key: 'feature.restaurant.v1',
        enabled: false,
        source: 'registry-default',
      });
    });

    it('keeps flag overrides inside their tenant', async () => {
      await configuration.flags.setFeatureFlag({
        tenantId: tenantA,
        key: 'feature.builder.v1',
        enabled: true,
      });
      expect(
        (
          await configuration.flags.resolveFeatureFlag({
            tenantId: tenantA,
            key: 'feature.builder.v1',
          })
        ).enabled,
      ).toBe(true);
      expect(
        (
          await configuration.flags.resolveFeatureFlag({
            tenantId: tenantB,
            key: 'feature.builder.v1',
          })
        ).enabled,
      ).toBe(false);

      // Clearing for B must not touch A's override.
      await configuration.flags.clearFeatureFlag({ tenantId: tenantB, key: 'feature.builder.v1' });
      expect(
        (
          await configuration.flags.resolveFeatureFlag({
            tenantId: tenantA,
            key: 'feature.builder.v1',
          })
        ).enabled,
      ).toBe(true);
    });

    it('returns declared flags only, never a stray row', async () => {
      if (!db) throw new Error('[slate/settings] database was not initialised.');
      await db
        .insertInto('feature_flag')
        .values({ tenant_id: tenantA, key: 'feature.invented.by-hand', enabled: true })
        .execute();

      const resolved = await configuration.flags.resolveFeatureFlags({ tenantId: tenantA });
      expect(resolved['feature.invented.by-hand']).toBeUndefined();
      // The undeclared key fails closed even though the row says `true`.
      expect(
        (
          await configuration.flags.resolveFeatureFlag({
            tenantId: tenantA,
            key: 'feature.invented.by-hand',
          })
        ).enabled,
      ).toBe(false);
    });

    it('never lets a write create an override for an undeclared flag', async () => {
      if (!db) throw new Error('[slate/settings] database was not initialised.');
      await expect(
        configuration.flags.setFeatureFlag({
          tenantId: tenantA,
          key: 'feature.invented.by-hand',
          enabled: false,
        }),
      ).rejects.toThrow(/not a declared feature flag/);
      const rows = await db
        .selectFrom('feature_flag')
        .select('key')
        .where('tenant_id', '=', tenantA)
        .where('key', '=', 'feature.invented.by-hand')
        .execute();
      // Only the row this suite inserted directly, not a second one.
      expect(rows).toHaveLength(1);
    });

    it('observes a committed flip on the next resolution (Section 65: no caching)', async () => {
      await configuration.flags.clearFeatureFlag({
        tenantId: tenantA,
        key: 'feature.ai.assistant',
      });
      expect(
        (
          await configuration.flags.resolveFeatureFlag({
            tenantId: tenantA,
            key: 'feature.ai.assistant',
          })
        ).enabled,
      ).toBe(false);
      await configuration.flags.setFeatureFlag({
        tenantId: tenantA,
        key: 'feature.ai.assistant',
        enabled: true,
      });
      expect(
        (
          await configuration.flags.resolveFeatureFlag({
            tenantId: tenantA,
            key: 'feature.ai.assistant',
          })
        ).enabled,
      ).toBe(true);
    });
  });

  describe('single-transaction audit (SLATE-203 contract)', () => {
    it('commits the setting and exactly one attributed audit row together', async () => {
      if (!db) throw new Error('[slate/settings] database was not initialised.');
      const before = await db
        .selectFrom('audit_log')
        .select('id')
        .where('tenant_id', '=', tenantA)
        .execute();

      await db.transaction().execute(async (trx) => {
        const withinTransaction = createTenantConfiguration(trx);
        await withinTransaction.settings.setSetting({
          tenantId: tenantA,
          key: 'branding.support_email',
          value: 'help@example.test',
        });
        await trx
          .insertInto('audit_log')
          .values({
            tenant_id: tenantA,
            actor_user_id: actorId,
            action: 'setting.updated',
            resource_type: 'system_setting',
            resource_id: 'branding.support_email',
            payload: { key: 'branding.support_email' },
          })
          .execute();
      });

      expect(
        (
          await configuration.settings.getSetting({
            tenantId: tenantA,
            key: 'branding.support_email',
          })
        )?.value,
      ).toBe('help@example.test');

      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('tenant_id', '=', tenantA)
        .where('action', '=', 'setting.updated')
        .execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tenant_id: tenantA,
        actor_user_id: actorId,
        resource_type: 'system_setting',
        resource_id: 'branding.support_email',
      });
      expect(audit).toHaveLength(before.length + 1);
    });

    it('rolls the setting back when the audit insert fails', async () => {
      if (!db) throw new Error('[slate/settings] database was not initialised.');
      await configuration.settings.setSetting({
        tenantId: tenantA,
        key: 'branding.rollback',
        value: 'original',
      });
      // Test-only constraint in this isolated schema: fail the final insert.
      await sql`alter table audit_log add constraint test_reject_audit
        check (action <> 'setting.updated') not valid`.execute(db);
      try {
        await expect(
          db.transaction().execute(async (trx) => {
            const withinTransaction = createTenantConfiguration(trx);
            await withinTransaction.settings.setSetting({
              tenantId: tenantA,
              key: 'branding.rollback',
              value: 'should-not-survive',
            });
            await trx
              .insertInto('audit_log')
              .values({
                tenant_id: tenantA,
                actor_user_id: actorId,
                action: 'setting.updated',
                resource_type: 'system_setting',
                resource_id: 'branding.rollback',
                payload: { key: 'branding.rollback' },
              })
              .execute();
          }),
        ).rejects.toThrow();

        // The write is gone; the previous committed value is intact.
        expect(
          (await configuration.settings.getSetting({ tenantId: tenantA, key: 'branding.rollback' }))
            ?.value,
        ).toBe('original');
      } finally {
        await sql`alter table audit_log drop constraint test_reject_audit`.execute(db);
      }
    });
  });
});
