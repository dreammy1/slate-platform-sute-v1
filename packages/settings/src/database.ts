/**
 * The one wiring factory for the configuration store.
 *
 * Mirrors `createAuth` in `@slate/auth`: it binds the semantic services to a real
 * database client, so callers never assemble the query service themselves.
 *
 * Pass a transaction to have the write and its `audit_log` row commit together:
 * this is exactly how SLATE-203's API wraps a mutation, and how a failed audit
 * insert rolls the configuration write back with it.
 */

import type { Kysely } from 'kysely';

import type { Database } from '@slate/database';

import { createFeatureFlags, type FeatureFlagService } from './flags-service.ts';
import { createSettingsQueryService } from './query-service.ts';
import { createSettings, type SettingsService } from './settings.ts';

/** The wired configuration surface: settings plus feature flags. */
export interface TenantConfiguration {
  readonly settings: SettingsService;
  readonly flags: FeatureFlagService;
}

/**
 * Wires the settings and feature flag services against one database client.
 *
 * @param db - a `Kysely<Database>` client, or a transaction of one.
 */
export function createTenantConfiguration(db: Kysely<Database>): TenantConfiguration {
  const queryService = createSettingsQueryService(db);
  return {
    settings: createSettings({ queryService }),
    flags: createFeatureFlags({ queryService }),
  };
}
