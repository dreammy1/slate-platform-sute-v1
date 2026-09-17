/**
 * The settings service: key/value validation in front of the query service.
 *
 * This layer owns everything that must be true regardless of who calls it -
 * keys are canonical ({@link assertSettingKey}), values are JSON-compatible
 * ({@link assertSettingValue}), and the type a value is read back with is the
 * type it was written with ({@link parseStoredSettingValue}). It touches the
 * database only through {@link SettingsQueryService}, which is also the seam the
 * unit suite replaces with a fake.
 *
 * Writes are not audited here: the `audit_log` row is part of the caller's
 * transaction (SLATE-203), so the API layer that opens that transaction owns it.
 */

import { assertSettingKey } from './keys.ts';
import type { SettingsQueryService, StoredSetting } from './query-service.ts';
import { SettingValueError } from './errors.ts';
import {
  SETTING_VALUE_TYPES,
  assertSettingValue,
  isSettingValueType,
  parseStoredSettingValue,
  typeOfSettingValue,
  type SettingRecord,
} from './values.ts';

/** A request to read or write one setting, always tenant-scoped. */
export interface SettingInput {
  /** Tenant the operation is confined to (from the resolved context). */
  readonly tenantId: string;
  /** Dotted, namespaced key. */
  readonly key: string;
}

/** A request to write one setting. */
export interface SetSettingInput extends SettingInput {
  /** Any JSON-compatible value; the stored type is derived from it. */
  readonly value: unknown;
}

/** The read/write surface for tenant-scoped settings. */
export interface SettingsService {
  /** Every setting of the tenant, ordered by key. */
  listSettings(input: { readonly tenantId: string }): Promise<readonly SettingRecord[]>;
  /** One setting, or `null` when the tenant has not set it. */
  getSetting(input: SettingInput): Promise<SettingRecord | null>;
  /** Inserts or replaces one setting and returns it as stored. */
  setSetting(input: SetSettingInput): Promise<SettingRecord>;
  /** Removes one setting; a no-op when the tenant has not set it. */
  clearSetting(input: SettingInput): Promise<void>;
}

/** Wires the settings service to a persistence seam. */
export function createSettings({
  queryService,
}: {
  readonly queryService: SettingsQueryService;
}): SettingsService {
  return {
    async listSettings({ tenantId }) {
      const rows = await queryService.listSettings(tenantId);
      return rows.map(toSettingRecord);
    },

    async getSetting({ tenantId, key }) {
      const row = await queryService.findSetting(tenantId, assertSettingKey(key));
      return row === null ? null : toSettingRecord(row);
    },

    async setSetting({ tenantId, key, value }) {
      const canonicalKey = assertSettingKey(key);
      const stored = assertSettingValue(value);
      const valueType = typeOfSettingValue(stored);
      // `assertSettingValue` already proved a type exists; this keeps the
      // invariant explicit rather than asserting it away with a cast.
      if (valueType === undefined) {
        throw new Error('[slate/settings] validated value has no storable type.');
      }
      // The value travels as the JavaScript value it is; turning it into JSON
      // text is the query service's job, so it is encoded exactly once.
      const saved = await queryService.upsertSetting(tenantId, {
        key: canonicalKey,
        valueType,
        value: stored,
      });
      return toSettingRecord(saved);
    },

    async clearSetting({ tenantId, key }) {
      await queryService.deleteSetting(tenantId, assertSettingKey(key));
    },
  };
}

/**
 * Rebuilds a {@link SettingRecord} from a stored row.
 *
 * The query service writes JSON text and PostgreSQL returns the parsed value, so
 * the row's `value` arrives as the JavaScript value it represents and
 * {@link parseStoredSettingValue} only has to prove the discriminator matches.
 */
function toSettingRecord(row: StoredSetting): SettingRecord {
  // An unknown discriminator is reported here so the check also narrows the
  // type; a known discriminator that disagrees with the value is refused by
  // `parseStoredSettingValue`. Either way an inconsistent row is never served.
  if (!isSettingValueType(row.valueType)) {
    throw new SettingValueError(
      `stored value_type "${row.valueType.slice(0, 32)}" is not one of: ${SETTING_VALUE_TYPES.join(', ')}.`,
    );
  }
  return {
    key: row.key,
    value: parseStoredSettingValue(row.valueType, row.value),
    valueType: row.valueType,
  };
}
