/**
 * The code-owned feature flag registry and its resolution rule.
 *
 * Master Plan Section 60 requires **server-authoritative** flags: "Flags allow
 * controlled rollout without changing entitlement logic."
 *
 * Two decisions make that hold (ADR 003):
 *
 * 1. **Definitions live in code, overrides live in the database.** Adding a flag
 *    is a reviewable code change, not a migration, and the set of flags a
 *    deployment can honour is visible in the pull request that introduces them.
 * 2. **An undeclared key resolves to `false`** - {@link resolveFeatureFlagEnabled}
 *    ignores an override for a key nobody declared, so a stray row can never
 *    switch on behaviour, and resolution never throws for input.
 *
 * The table therefore stores only where a tenant *deviates* from the default;
 * an absent row means "use the registry default".
 */

import { FeatureFlagKeyError } from './errors.ts';

/** What a flag is and what it resolves to when a tenant has no override. */
export interface FeatureFlagDefinition {
  /** Short, human-readable description of what the flag switches on. */
  readonly description: string;
  /** Resolution for a tenant with no override. */
  readonly defaultEnabled: boolean;
}

/** A registry of flag keys to their definitions. */
export type FeatureFlagRegistry = Readonly<Record<string, FeatureFlagDefinition>>;

/**
 * Every flag this platform can resolve.
 *
 * Keys are dotted and namespaced (Section 60's own examples), so a flag reads as
 * the capability it gates and can never collide with another module's flag.
 */
export const FEATURE_FLAGS = {
  'feature.restaurant.v1': {
    description: 'Restaurant module (menus, tables, orders).',
    defaultEnabled: false,
  },
  'feature.builder.v1': {
    description: 'Visual website/page builder.',
    defaultEnabled: false,
  },
  'feature.ai.assistant': {
    description: 'AI assistant surfaces backed by the AI gateway.',
    defaultEnabled: false,
  },
  'feature.new-checkout': {
    description: 'New checkout flow; enables controlled rollout.',
    defaultEnabled: false,
  },
} as const satisfies FeatureFlagRegistry;

/** A key declared in {@link FEATURE_FLAGS}. */
export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

/** Every declared flag key, in declaration order. */
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as readonly FeatureFlagKey[];

/** Narrows an arbitrary string to a declared flag key. */
export function isKnownFeatureFlag(key: string): key is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, key);
}

/** The {@link FeatureFlagDefinition} for a declared key, or `undefined`. */
export function featureFlagDefinition(key: string): FeatureFlagDefinition | undefined {
  return isKnownFeatureFlag(key)
    ? (FEATURE_FLAGS[key] as FeatureFlagDefinition)
    : (undefined as FeatureFlagDefinition | undefined);
}

/**
 * The default for a key when the tenant has no override: the registry default
 * for a declared flag, `false` for an undeclared one (fail closed).
 */
export function featureFlagDefault(key: string): boolean {
  return featureFlagDefinition(key)?.defaultEnabled ?? false;
}

/**
 * The one resolution rule: **override → registry default → false**.
 *
 * An override is honored only for a declared key; an undeclared key is `false`
 * even when a row claims otherwise, so the fallback is closed rather than open.
 * Resolution is pure and never throws - a caller asking about a flag it does not
 * know must get an answer, not an exception.
 */
export function resolveFeatureFlagEnabled(key: string, override?: boolean | undefined): boolean {
  const definition = featureFlagDefinition(key);
  if (definition === undefined) return false;
  return override ?? definition.defaultEnabled;
}

/**
 * Validates that a flag key is declared, so a write can never create an override
 * for behaviour nobody defined.
 *
 * @throws {@link FeatureFlagKeyError} for an undeclared or malformed key.
 */
export function assertKnownFeatureFlag(key: string): FeatureFlagKey {
  if (!isKnownFeatureFlag(key)) {
    throw new FeatureFlagKeyError(
      `"${String(key).slice(0, 64)}" is not a declared feature flag; the registry declares ${FEATURE_FLAG_KEYS.join(', ')}.`,
    );
  }
  return key;
}
