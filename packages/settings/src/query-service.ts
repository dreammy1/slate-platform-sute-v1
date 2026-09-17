/**
 * The persistence seam for the configuration store.
 *
 * Every method goes through the SLATE-200 scoped helper
 * `createTenantDatabase(db, tenantId)`, which forces `where tenant_id = $1` on
 * selects, injects the scope's `tenant_id` on inserts and confines updates and
 * deletes to the scope. Isolation is therefore inherited from SLATE-201 rather
 * than re-implemented here: a query that crosses the tenant boundary is not
 * expressible in this file.
 *
 * The interface exists so the semantic layer (`settings.ts`, `flags.ts`) can be
 * unit-tested against a fake that proves which tenant each call was made for;
 * `createSettingsQueryService` is the only implementation that talks to
 * PostgreSQL.
 */

import { sql, type Kysely } from 'kysely';

import { createTenantDatabase, type Database } from '@slate/database';

import { toJsonbText, type SettingValue } from './values.ts';

/** A setting row as stored: the value as the driver hands back a `jsonb` column. */
export interface StoredSetting {
  readonly key: string;
  readonly valueType: string;
  readonly value: unknown;
}

/** A feature flag override row as stored. */
export interface StoredFeatureFlag {
  readonly key: string;
  readonly enabled: boolean;
}

/** The tenant-scoped persistence operations the configuration store needs. */
export interface SettingsQueryService {
  /** Every setting of the tenant, ordered by key. */
  listSettings(tenantId: string): Promise<readonly StoredSetting[]>;
  /** One setting of the tenant, or `null`. */
  findSetting(tenantId: string, key: string): Promise<StoredSetting | null>;
  /** Inserts or replaces one setting inside the tenant. */
  upsertSetting(tenantId: string, setting: StoredSetting): Promise<StoredSetting>;
  /** Deletes one setting of the tenant; a no-op when it does not exist. */
  deleteSetting(tenantId: string, key: string): Promise<void>;
  /** Every flag override of the tenant, ordered by key. */
  listFeatureFlags(tenantId: string): Promise<readonly StoredFeatureFlag[]>;
  /** One flag override of the tenant, or `null` when the tenant uses the default. */
  findFeatureFlag(tenantId: string, key: string): Promise<StoredFeatureFlag | null>;
  /** Inserts or replaces one flag override inside the tenant. */
  upsertFeatureFlag(tenantId: string, key: string, enabled: boolean): Promise<StoredFeatureFlag>;
  /** Removes one flag override, reverting the tenant to the registry default. */
  deleteFeatureFlag(tenantId: string, key: string): Promise<void>;
}

/** The `system_setting` columns the read path selects. */
const SETTING_COLUMNS = ['key', 'value_type as valueType', 'value'] as const;

/**
 * Wires {@link SettingsQueryService} to a Kysely client.
 *
 * @param db - a `Kysely<Database>` client, or a transaction of one: a caller that
 *   needs the write and its `audit_log` row to commit together passes the
 *   transaction in, exactly as SLATE-203 does for user creation.
 */
export function createSettingsQueryService(db: Kysely<Database>): SettingsQueryService {
  return {
    async listSettings(tenantId) {
      return createTenantDatabase(db, tenantId)
        .selectFrom('system_setting')
        .select([...SETTING_COLUMNS])
        .orderBy('key')
        .execute();
    },

    async findSetting(tenantId, key) {
      const row = await createTenantDatabase(db, tenantId)
        .selectFrom('system_setting')
        .select([...SETTING_COLUMNS])
        .where('key', '=', key)
        .executeTakeFirst();
      return row ?? null;
    },

    async upsertSetting(tenantId, setting) {
      // `jsonb` input is parsed as JSON, so the value is written as JSON text:
      // a bare `en-GB` would be rejected while `"en-GB"` is a JSON string.
      const valueText = toJsonbText(setting.value as SettingValue);
      // One statement, so two concurrent writers cannot both "insert then find
      // nothing": the unique (tenant_id, key) index makes the second writer an
      // update instead of a duplicate-key failure.
      const row = await createTenantDatabase(db, tenantId)
        .insertInto('system_setting', {
          key: setting.key,
          value_type: setting.valueType,
          value: valueText,
        })
        .onConflict((conflict) =>
          conflict.columns(['tenant_id', 'key']).doUpdateSet({
            value_type: setting.valueType,
            value: valueText,
            updated_at: sql<Date>`now()`,
          }),
        )
        .returning([...SETTING_COLUMNS])
        .executeTakeFirstOrThrow();
      return row;
    },

    async deleteSetting(tenantId, key) {
      await createTenantDatabase(db, tenantId)
        .deleteFrom('system_setting')
        .where('key', '=', key)
        .execute();
    },

    async listFeatureFlags(tenantId) {
      return createTenantDatabase(db, tenantId)
        .selectFrom('feature_flag')
        .select(['key', 'enabled'])
        .orderBy('key')
        .execute();
    },

    async findFeatureFlag(tenantId, key) {
      const row = await createTenantDatabase(db, tenantId)
        .selectFrom('feature_flag')
        .select(['key', 'enabled'])
        .where('key', '=', key)
        .executeTakeFirst();
      return row ?? null;
    },

    async upsertFeatureFlag(tenantId, key, enabled) {
      const row = await createTenantDatabase(db, tenantId)
        .insertInto('feature_flag', { key, enabled })
        .onConflict((conflict) =>
          conflict.columns(['tenant_id', 'key']).doUpdateSet({
            enabled,
            updated_at: sql<Date>`now()`,
          }),
        )
        .returning(['key', 'enabled'])
        .executeTakeFirstOrThrow();
      return row;
    },

    async deleteFeatureFlag(tenantId, key) {
      await createTenantDatabase(db, tenantId)
        .deleteFrom('feature_flag')
        .where('key', '=', key)
        .execute();
    },
  };
}
