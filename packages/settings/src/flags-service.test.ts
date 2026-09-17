import { beforeEach, describe, expect, it } from 'vitest';

import { FeatureFlagKeyError } from './errors.ts';
import { createFeatureFlags, type FeatureFlagService } from './flags-service.ts';
import { FEATURE_FLAG_KEYS, featureFlagDefault } from './flags.ts';
import { createFakeSettingsQueryService, type FakeSettingsQueryService } from './testing.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const FLAG = 'feature.new-checkout';
const OTHER = 'feature.restaurant.v1';
const UNDECLARED = 'feature.undeclared';

let queryService: FakeSettingsQueryService;
let flags: FeatureFlagService;

beforeEach(() => {
  queryService = createFakeSettingsQueryService();
  flags = createFeatureFlags({ queryService });
});

describe('resolveFeatureFlags', () => {
  it('reports every declared flag at its registry default, and nothing else', async () => {
    const resolved = await flags.resolveFeatureFlags({ tenantId: TENANT_A });
    expect(Object.keys(resolved)).toEqual([...FEATURE_FLAG_KEYS]);
    for (const key of FEATURE_FLAG_KEYS) expect(resolved[key]).toBe(featureFlagDefault(key));
  });

  it('honours an override without disturbing the other flags', async () => {
    await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: true });
    const resolved = await flags.resolveFeatureFlags({ tenantId: TENANT_A });
    expect(resolved[FLAG]).toBe(true);
    expect(resolved[OTHER]).toBe(featureFlagDefault(OTHER));
  });

  it('never reports an undeclared key, even one with a stored row', async () => {
    // A stray row must not become an API-visible flag (Section 60).
    queryService.seedFeatureFlag(TENANT_A, UNDECLARED, true);
    const resolved = await flags.resolveFeatureFlags({ tenantId: TENANT_A });
    expect(Object.keys(resolved)).toEqual([...FEATURE_FLAG_KEYS]);
    expect(resolved[UNDECLARED]).toBeUndefined();
  });
});

describe('resolveFeatureFlag', () => {
  it('reports the registry default as the source when there is no override', async () => {
    expect(await flags.resolveFeatureFlag({ tenantId: TENANT_A, key: FLAG })).toEqual({
      key: FLAG,
      enabled: featureFlagDefault(FLAG),
      source: 'registry-default',
    });
  });

  it('reports the override as the source when one exists', async () => {
    await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: true });
    expect(await flags.resolveFeatureFlag({ tenantId: TENANT_A, key: FLAG })).toEqual({
      key: FLAG,
      enabled: true,
      source: 'override',
    });
  });

  it('resolves an undeclared key to false and never throws', async () => {
    expect(await flags.resolveFeatureFlag({ tenantId: TENANT_A, key: UNDECLARED })).toEqual({
      key: UNDECLARED,
      enabled: false,
      source: 'undeclared',
    });
  });

  it('ignores a stored override for an undeclared key', async () => {
    queryService.seedFeatureFlag(TENANT_A, UNDECLARED, true);
    expect(await flags.resolveFeatureFlag({ tenantId: TENANT_A, key: UNDECLARED })).toEqual({
      key: UNDECLARED,
      enabled: false,
      source: 'undeclared',
    });
  });
});
describe('setFeatureFlag', () => {
  it('upserts an override and returns the resolved flag', async () => {
    expect(await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: true })).toEqual({
      key: FLAG,
      enabled: true,
      source: 'override',
    });
    expect(await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: false })).toEqual({
      key: FLAG,
      enabled: false,
      source: 'override',
    });
  });

  it('keeps one override row per flag when the same flag is set twice', async () => {
    await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: true });
    await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: false });
    expect(queryService.flagsFor(TENANT_A)).toEqual([{ key: FLAG, enabled: false }]);
  });

  it('clears the override when enabled is null, reverting to the default', async () => {
    await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: true });
    expect(await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: null })).toEqual({
      key: FLAG,
      enabled: featureFlagDefault(FLAG),
      source: 'registry-default',
    });
    expect(queryService.flagsFor(TENANT_A)).toEqual([]);
  });

  it('rejects an undeclared key before touching the store', async () => {
    await expect(
      flags.setFeatureFlag({ tenantId: TENANT_A, key: UNDECLARED, enabled: true }),
    ).rejects.toThrow(FeatureFlagKeyError);
    expect(queryService.calls).toEqual([]);
    expect(queryService.flagsFor(TENANT_A)).toEqual([]);
  });
});

describe('clearFeatureFlag', () => {
  it('reverts the tenant to the registry default', async () => {
    await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: true });
    expect(await flags.clearFeatureFlag({ tenantId: TENANT_A, key: FLAG })).toEqual({
      key: FLAG,
      enabled: featureFlagDefault(FLAG),
      source: 'registry-default',
    });
    expect(queryService.flagsFor(TENANT_A)).toEqual([]);
  });

  it('rejects an undeclared key before touching the store', async () => {
    await expect(flags.clearFeatureFlag({ tenantId: TENANT_A, key: UNDECLARED })).rejects.toThrow(
      FeatureFlagKeyError,
    );
    expect(queryService.calls).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it("keeps one tenant's override invisible to another", async () => {
    await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: true });
    expect((await flags.resolveFeatureFlag({ tenantId: TENANT_A, key: FLAG })).enabled).toBe(true);
    expect((await flags.resolveFeatureFlag({ tenantId: TENANT_B, key: FLAG })).enabled).toBe(
      featureFlagDefault(FLAG),
    );
    expect(queryService.flagsFor(TENANT_B)).toEqual([]);
  });

  it("passes the caller's tenant to every persistence call", async () => {
    await flags.setFeatureFlag({ tenantId: TENANT_B, key: FLAG, enabled: true });
    await flags.resolveFeatureFlag({ tenantId: TENANT_B, key: FLAG });
    // A write resolves the flag it just changed, so `findFeatureFlag` runs twice.
    expect(queryService.calls).toEqual([
      `upsertFeatureFlag(${TENANT_B}, ${FLAG}, true)`,
      `findFeatureFlag(${TENANT_B}, ${FLAG})`,
      `findFeatureFlag(${TENANT_B}, ${FLAG})`,
    ]);
  });

  it('does not let one tenant clear another tenant override', async () => {
    await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: true });
    await flags.clearFeatureFlag({ tenantId: TENANT_B, key: FLAG });
    expect(queryService.flagsFor(TENANT_A)).toEqual([{ key: FLAG, enabled: true }]);
  });
});

describe('no caching (Section 65)', () => {
  it('observes a committed change on the very next resolution', async () => {
    expect((await flags.resolveFeatureFlag({ tenantId: TENANT_A, key: FLAG })).enabled).toBe(false);
    await flags.setFeatureFlag({ tenantId: TENANT_A, key: FLAG, enabled: true });
    expect((await flags.resolveFeatureFlag({ tenantId: TENANT_A, key: FLAG })).enabled).toBe(true);
    await flags.clearFeatureFlag({ tenantId: TENANT_A, key: FLAG });
    expect((await flags.resolveFeatureFlag({ tenantId: TENANT_A, key: FLAG })).enabled).toBe(false);
  });
});
