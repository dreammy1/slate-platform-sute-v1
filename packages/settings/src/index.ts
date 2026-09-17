/**
 * `@slate/settings` - tenant-scoped system settings and server-authoritative
 * feature flags (SLATE-204).
 *
 * ## Settings
 *
 * A setting is tenant-owned configuration data: a dotted, namespaced key
 * (`branding.locale`) with a JSON-compatible value stored together with its
 * type, so a value round-trips as the type it was written with. Reads and writes
 * go through the SLATE-200 scoped helper `db(tenantId)`, so a cross-tenant
 * access is not expressible at the call site.
 *
 * ## Feature flags
 *
 * A flag is a **rollout switch the server owns** (Master Plan Section 60).
 * Definitions and defaults live in code ({@link FEATURE_FLAGS}); the database
 * stores per-tenant overrides only. Resolution is
 * `override → registry default → false`, and an undeclared key is always `false`
 * - fail closed, never an exception.
 *
 * ## Security
 *
 * - Tenant ids are resolved server-side from the request context; nothing here
 *   trusts a client-supplied tenant (Section 13).
 * - Resolution is recomputed on every call - no caching - so a flipped flag or a
 *   revoked permission is effective immediately (Section 65).
 * - Values are never placed in events or log records; only keys are (Section 61).
 *
 * ## Out of scope
 *
 * Flag targeting rules (per-user, percentage rollout, scheduling), entitlement
 * gating (Phase 6), plugin-registered settings (Phase 5) and caching - see
 * docs/adr/003-system-settings-and-feature-flags.md.
 */

export { SettingKeyError, SettingValueError, FeatureFlagKeyError } from './errors.ts';

export {
  MAX_SETTING_KEY_LENGTH,
  MAX_SETTING_KEY_SEGMENT_LENGTH,
  MIN_SETTING_KEY_SEGMENTS,
  SETTING_KEY_PATTERN,
  assertSettingKey,
  isValidSettingKey,
  settingKeyNamespace,
} from './keys.ts';

export {
  MAX_SETTING_JSON_DEPTH,
  MAX_SETTING_STRING_LENGTH,
  SETTING_VALUE_TYPES,
  assertSettingValue,
  isSettingValueType,
  parseStoredSettingValue,
  toJsonbText,
  typeOfSettingValue,
} from './values.ts';
export type {
  SettingJson,
  SettingJsonArray,
  SettingJsonObject,
  SettingRecord,
  SettingValue,
  SettingValueType,
} from './values.ts';

export {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  assertKnownFeatureFlag,
  featureFlagDefault,
  featureFlagDefinition,
  isKnownFeatureFlag,
  resolveFeatureFlagEnabled,
} from './flags.ts';
export type { FeatureFlagDefinition, FeatureFlagKey, FeatureFlagRegistry } from './flags.ts';

export { createSettings } from './settings.ts';
export type { SetSettingInput, SettingInput, SettingsService } from './settings.ts';

export { createFeatureFlags } from './flags-service.ts';
export type {
  FeatureFlagResolution,
  FeatureFlagService,
  FeatureFlagSource,
  SetFeatureFlagInput,
} from './flags-service.ts';

export { createSettingsQueryService } from './query-service.ts';
export type { SettingsQueryService, StoredFeatureFlag, StoredSetting } from './query-service.ts';

export { createTenantConfiguration } from './database.ts';
export type { TenantConfiguration } from './database.ts';
