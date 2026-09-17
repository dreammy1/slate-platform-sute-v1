/**
 * An in-memory {@link SettingsQueryService} for the unit suite.
 *
 * Deliberately **not** exported from the package barrel: it is test scaffolding,
 * not an API. It exists so the semantic layer can be tested without PostgreSQL
 * while still proving two things that matter:
 *
 * 1. every call carries the tenant the caller asked for (the `calls` log), and
 * 2. a row written for one tenant is invisible to another, because rows are keyed
 *    by tenant and key together.
 *
 * The real isolation proof runs against PostgreSQL in
 * `settings.integration.test.ts`; this fake keeps the fast suite honest about the
 * contract the real service must keep.
 */

import type { SettingsQueryService, StoredFeatureFlag, StoredSetting } from './query-service.ts';

/** A {@link SettingsQueryService} that records every call and stores rows per tenant. */
export interface FakeSettingsQueryService extends SettingsQueryService {
  /** Every call made, in order, as `method(tenantId, ...)`. */
  readonly calls: readonly string[];
  /** Rows currently stored for one tenant, in insertion order. */
  rowsFor(tenantId: string): readonly StoredSetting[];
  /** Flag overrides currently stored for one tenant. */
  flagsFor(tenantId: string): readonly StoredFeatureFlag[];
  /**
   * Inserts a raw row bypassing the semantic layer, for corruption tests. The
   * row is given in the shape the driver produces for it.
   */
  seedSetting(tenantId: string, setting: StoredSetting): void;
  /** Inserts a raw flag override, bypassing the registry check. */
  seedFeatureFlag(tenantId: string, key: string, enabled: boolean): void;
}

/** `tenantId` and `key` are joined so rows can never leak across tenants. */
function rowId(tenantId: string, key: string): string {
  return `${tenantId}\u0000${key}`;
}

/** Creates an empty {@link FakeSettingsQueryService}. */
export function createFakeSettingsQueryService(): FakeSettingsQueryService {
  const settings = new Map<string, StoredSetting>();
  const flags = new Map<string, boolean>();
  const calls: string[] = [];

  const settingsOf = (tenantId: string): StoredSetting[] =>
    [...settings.entries()]
      .filter(([id]) => id.startsWith(`${tenantId}\u0000`))
      .map(([, row]) => row);

  return {
    calls,

    rowsFor: (tenantId) => settingsOf(tenantId),

    flagsFor: (tenantId) =>
      [...flags.entries()]
        .filter(([id]) => id.startsWith(`${tenantId}\u0000`))
        .map(([id, enabled]) => ({ key: id.slice(id.indexOf('\u0000') + 1), enabled })),

    seedSetting(tenantId, setting) {
      settings.set(rowId(tenantId, setting.key), setting);
    },

    seedFeatureFlag(tenantId, key, enabled) {
      flags.set(rowId(tenantId, key), enabled);
    },

    async listSettings(tenantId) {
      calls.push(`listSettings(${tenantId})`);
      return settingsOf(tenantId);
    },

    async findSetting(tenantId, key) {
      calls.push(`findSetting(${tenantId}, ${key})`);
      return settings.get(rowId(tenantId, key)) ?? null;
    },

    async upsertSetting(tenantId, setting) {
      calls.push(`upsertSetting(${tenantId}, ${setting.key})`);
      // The fake stands in for the whole query service, so it receives the
      // value the way the service does - as a JavaScript value, not JSON text -
      // and returns a row shaped like the driver's `returning` output.
      settings.set(rowId(tenantId, setting.key), setting);
      return setting;
    },

    async deleteSetting(tenantId, key) {
      calls.push(`deleteSetting(${tenantId}, ${key})`);
      settings.delete(rowId(tenantId, key));
    },

    async listFeatureFlags(tenantId) {
      calls.push(`listFeatureFlags(${tenantId})`);
      return [...flags.entries()]
        .filter(([id]) => id.startsWith(`${tenantId}\u0000`))
        .map(([id, enabled]) => ({ key: id.slice(id.indexOf('\u0000') + 1), enabled }));
    },

    async findFeatureFlag(tenantId, key) {
      calls.push(`findFeatureFlag(${tenantId}, ${key})`);
      const enabled = flags.get(rowId(tenantId, key));
      return enabled === undefined ? null : { key, enabled };
    },

    async upsertFeatureFlag(tenantId, key, enabled) {
      calls.push(`upsertFeatureFlag(${tenantId}, ${key}, ${String(enabled)})`);
      flags.set(rowId(tenantId, key), enabled);
      return { key, enabled };
    },

    async deleteFeatureFlag(tenantId, key) {
      calls.push(`deleteFeatureFlag(${tenantId}, ${key})`);
      flags.delete(rowId(tenantId, key));
    },
  };
}
