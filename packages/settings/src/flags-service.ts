/**
 * The feature flag service: server-authoritative resolution over the registry.
 *
 * The rules this layer enforces (ADR 003, Master Plan Section 60):
 *
 * - the resolved map contains **declared** flags only, resolved for the tenant
 *   that was asked for;
 * - resolution is `override → registry default → false`, and an undeclared key
 *   is `false` even when an override row exists, so a stray row cannot switch on
 *   behaviour;
 * - a **write** may only address a declared flag ({@link assertKnownFeatureFlag}),
 *   because enabling behaviour nobody defined is not a rollout, it is a fault;
 * - `clearFeatureFlag` removes the override so the tenant reverts to the default.
 *
 * Like the settings service, this layer never writes an `audit_log` row itself:
 * the caller's transaction owns the audit (SLATE-203).
 */

import {
  FEATURE_FLAG_KEYS,
  assertKnownFeatureFlag,
  isKnownFeatureFlag,
  resolveFeatureFlagEnabled,
} from './flags.ts';
import type { SettingsQueryService } from './query-service.ts';

/** Where a resolved flag value came from - useful in tests and diagnostics. */
export type FeatureFlagSource = 'override' | 'registry-default' | 'undeclared';

/** One resolved flag. */
export interface FeatureFlagResolution {
  /** The key that was asked about, echoed back unchanged. */
  readonly key: string;
  /** The effective value for the tenant. Never client-supplied. */
  readonly enabled: boolean;
  /** Which rule produced {@link enabled}. */
  readonly source: FeatureFlagSource;
}

/** A tenant-scoped flag write: set, or clear back to the registry default. */
export interface SetFeatureFlagInput {
  /** Tenant the write is confined to (from the resolved context). */
  readonly tenantId: string;
  /** Declared flag key. */
  readonly key: string;
  /** `true`/`false` sets an override; `null` clears it. */
  readonly enabled: boolean | null;
}

/** The read/write surface for tenant-scoped feature flags. */
export interface FeatureFlagService {
  /** The resolved map for the tenant: declared flags only, keyed by flag key. */
  resolveFeatureFlags(input: { readonly tenantId: string }): Promise<Record<string, boolean>>;
  /** One resolved flag, including the rule that produced it. */
  resolveFeatureFlag(input: {
    readonly tenantId: string;
    readonly key: string;
  }): Promise<FeatureFlagResolution>;
  /** Sets or clears one override and returns the resulting resolution. */
  setFeatureFlag(input: SetFeatureFlagInput): Promise<FeatureFlagResolution>;
  /** Clears one override, reverting the tenant to the registry default. */
  clearFeatureFlag(input: {
    readonly tenantId: string;
    readonly key: string;
  }): Promise<FeatureFlagResolution>;
}

/** Wires the feature flag service to a persistence seam. */
export function createFeatureFlags({
  queryService,
}: {
  readonly queryService: SettingsQueryService;
}): FeatureFlagService {
  async function resolution(tenantId: string, key: string): Promise<FeatureFlagResolution> {
    if (!isKnownFeatureFlag(key)) {
      // Fail closed and never throw: an undeclared key resolves to `false`,
      // whatever rows exist for it.
      return { key, enabled: false, source: 'undeclared' };
    }
    const override = await queryService.findFeatureFlag(tenantId, key);
    return {
      key,
      enabled: resolveFeatureFlagEnabled(key, override?.enabled),
      source: override === null ? 'registry-default' : 'override',
    };
  }

  return {
    async resolveFeatureFlags({ tenantId }) {
      const overrides = await queryService.listFeatureFlags(tenantId);
      const byKey = new Map(overrides.map((flag) => [flag.key, flag.enabled]));
      const resolved: Record<string, boolean> = {};
      // The registry decides which keys exist; the rows only decide their value.
      for (const key of FEATURE_FLAG_KEYS) {
        resolved[key] = resolveFeatureFlagEnabled(key, byKey.get(key));
      }
      return resolved;
    },

    resolveFeatureFlag: ({ tenantId, key }) => resolution(tenantId, key),

    async setFeatureFlag({ tenantId, key, enabled }) {
      assertKnownFeatureFlag(key);
      if (enabled === null) {
        await queryService.deleteFeatureFlag(tenantId, key);
      } else {
        await queryService.upsertFeatureFlag(tenantId, key, enabled);
      }
      return resolution(tenantId, key);
    },

    async clearFeatureFlag({ tenantId, key }) {
      assertKnownFeatureFlag(key);
      await queryService.deleteFeatureFlag(tenantId, key);
      return resolution(tenantId, key);
    },
  };
}
