import { describe, expect, it } from 'vitest';

import { FeatureFlagKeyError } from './errors.ts';
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  assertKnownFeatureFlag,
  featureFlagDefault,
  featureFlagDefinition,
  isKnownFeatureFlag,
  resolveFeatureFlagEnabled,
} from './flags.ts';

describe('feature flag registry', () => {
  it('declares the Section 60 example flags', () => {
    expect(FEATURE_FLAG_KEYS).toEqual([
      'feature.restaurant.v1',
      'feature.builder.v1',
      'feature.ai.assistant',
      'feature.new-checkout',
    ]);
  });

  it('gives every declared flag a description and a default', () => {
    for (const key of FEATURE_FLAG_KEYS) {
      const definition = featureFlagDefinition(key);
      expect(definition?.description).toBeTruthy();
      expect(typeof definition?.defaultEnabled).toBe('boolean');
    }
  });

  it('keeps the registry and its key list in step', () => {
    expect(Object.keys(FEATURE_FLAGS)).toEqual([...FEATURE_FLAG_KEYS]);
  });

  it('recognizes only declared keys', () => {
    expect(isKnownFeatureFlag('feature.new-checkout')).toBe(true);
    expect(isKnownFeatureFlag('feature.undeclared')).toBe(false);
    expect(isKnownFeatureFlag('')).toBe(false);
    expect(isKnownFeatureFlag('constructor')).toBe(false);
    expect(isKnownFeatureFlag('toString')).toBe(false);
  });
});

describe('resolveFeatureFlagEnabled', () => {
  it('prefers an override over the registry default', () => {
    expect(resolveFeatureFlagEnabled('feature.new-checkout', true)).toBe(true);
    expect(featureFlagDefault('feature.new-checkout')).toBe(false);
    expect(resolveFeatureFlagEnabled('feature.new-checkout', false)).toBe(false);
  });

  it('falls back to the registry default when there is no override', () => {
    for (const key of FEATURE_FLAG_KEYS) {
      expect(resolveFeatureFlagEnabled(key, undefined)).toBe(featureFlagDefault(key));
    }
  });

  it('resolves an undeclared key to false, even when an override says otherwise', () => {
    // Fail closed: a stray row must never switch on behaviour nobody declared.
    expect(resolveFeatureFlagEnabled('feature.undeclared')).toBe(false);
    expect(resolveFeatureFlagEnabled('feature.undeclared', true)).toBe(false);
    expect(resolveFeatureFlagEnabled('constructor', true)).toBe(false);
    expect(featureFlagDefault('feature.undeclared')).toBe(false);
  });

  it('never throws for input - resolution is an answer, not an exception', () => {
    expect(() => resolveFeatureFlagEnabled('')).not.toThrow();
    expect(() => resolveFeatureFlagEnabled('feature.undeclared', undefined)).not.toThrow();
  });
});

describe('featureFlagDefinition', () => {
  it('returns the definition for a declared key', () => {
    expect(featureFlagDefinition('feature.ai.assistant')?.description).toMatch(/AI assistant/);
  });

  it('returns undefined for an undeclared key', () => {
    expect(featureFlagDefinition('feature.undeclared')).toBeUndefined();
  });
});

describe('assertKnownFeatureFlag', () => {
  it('returns a declared key unchanged', () => {
    expect(assertKnownFeatureFlag('feature.builder.v1')).toBe('feature.builder.v1');
  });

  it('refuses an override for behaviour nobody defined', () => {
    expect(() => assertKnownFeatureFlag('feature.undeclared')).toThrow(FeatureFlagKeyError);
    expect(() => assertKnownFeatureFlag('feature.undeclared')).toThrow(
      /not a declared feature flag/,
    );
  });
});
