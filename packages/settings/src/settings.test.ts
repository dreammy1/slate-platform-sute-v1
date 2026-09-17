import { beforeEach, describe, expect, it } from 'vitest';

import { SettingKeyError, SettingValueError } from './errors.ts';
import { createSettings, type SettingsService } from './settings.ts';
import { createFakeSettingsQueryService, type FakeSettingsQueryService } from './testing.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

let queryService: FakeSettingsQueryService;
let settings: SettingsService;

beforeEach(() => {
  queryService = createFakeSettingsQueryService();
  settings = createSettings({ queryService });
});

describe('setSetting', () => {
  it.each([
    ['branding.locale', 'en-GB', 'string'],
    ['pricing.tax_rate', 19.5, 'number'],
    ['booking.require_deposit', true, 'boolean'],
    ['branding.theme', { accent: '#0af', dark: false }, 'json'],
    ['search.facets', ['crm', 'booking'], 'json'],
  ])('stores %s with the type it was written with', async (key, value, valueType) => {
    const saved = await settings.setSetting({ tenantId: TENANT_A, key, value });
    expect(saved).toEqual({ key, value, valueType });
    const read = await settings.getSetting({ tenantId: TENANT_A, key });
    expect(read?.value).toStrictEqual(value);
    expect(read?.valueType).toBe(valueType);
  });

  it('hands the query service the value itself, not pre-encoded text', async () => {
    // Encoding is the query service's single responsibility: if this layer also
    // stringified, the value would be encoded twice and `en-GB` would come back
    // as the four extra characters `"en-GB"`.
    await settings.setSetting({ tenantId: TENANT_A, key: 'branding.locale', value: 'en-GB' });
    expect(queryService.rowsFor(TENANT_A)).toEqual([
      { key: 'branding.locale', valueType: 'string', value: 'en-GB' },
    ]);
  });

  it('replaces an existing value instead of adding a second row', async () => {
    await settings.setSetting({ tenantId: TENANT_A, key: 'branding.locale', value: 'en-GB' });
    await settings.setSetting({ tenantId: TENANT_A, key: 'branding.locale', value: 'fr-FR' });
    expect(queryService.rowsFor(TENANT_A)).toHaveLength(1);
    expect((await settings.getSetting({ tenantId: TENANT_A, key: 'branding.locale' }))?.value).toBe(
      'fr-FR',
    );
  });

  it('rejects an invalid key before touching the store', async () => {
    await expect(
      settings.setSetting({ tenantId: TENANT_A, key: 'locale', value: 'en-GB' }),
    ).rejects.toThrow(SettingKeyError);
    expect(queryService.calls).toEqual([]);
  });

  it('rejects an unstorable value before touching the store', async () => {
    await expect(
      settings.setSetting({ tenantId: TENANT_A, key: 'branding.created', value: new Date() }),
    ).rejects.toThrow(SettingValueError);
    expect(queryService.calls).toEqual([]);
  });
});
describe('getSetting', () => {
  it('answers null when the tenant has not set the key', async () => {
    expect(await settings.getSetting({ tenantId: TENANT_A, key: 'branding.locale' })).toBeNull();
  });

  it('validates the key before querying', async () => {
    await expect(settings.getSetting({ tenantId: TENANT_A, key: 'locale' })).rejects.toThrow(
      SettingKeyError,
    );
    expect(queryService.calls).toEqual([]);
  });

  it('refuses to serve a stored row whose type disagrees with its value', async () => {
    queryService.seedSetting(TENANT_A, {
      key: 'pricing.tax_rate',
      valueType: 'string',
      value: 19.5,
    });
    await expect(
      settings.getSetting({ tenantId: TENANT_A, key: 'pricing.tax_rate' }),
    ).rejects.toThrow(SettingValueError);
  });

  it('refuses to serve a stored row with an unknown type', async () => {
    queryService.seedSetting(TENANT_A, {
      key: 'pricing.tax_rate',
      valueType: 'decimal',
      value: 19.5,
    });
    await expect(
      settings.getSetting({ tenantId: TENANT_A, key: 'pricing.tax_rate' }),
    ).rejects.toThrow(SettingValueError);
  });
});

describe('listSettings', () => {
  it('returns every setting of the tenant, ordered by key', async () => {
    await settings.setSetting({ tenantId: TENANT_A, key: 'branding.locale', value: 'en-GB' });
    await settings.setSetting({ tenantId: TENANT_A, key: 'pricing.tax_rate', value: 19.5 });
    expect(await settings.listSettings({ tenantId: TENANT_A })).toEqual([
      { key: 'branding.locale', value: 'en-GB', valueType: 'string' },
      { key: 'pricing.tax_rate', value: 19.5, valueType: 'number' },
    ]);
  });

  it('is an empty list for a tenant with no configuration', async () => {
    expect(await settings.listSettings({ tenantId: TENANT_A })).toEqual([]);
  });
});
describe('clearSetting', () => {
  it('removes only the addressed tenant and key', async () => {
    await settings.setSetting({ tenantId: TENANT_A, key: 'branding.locale', value: 'en-GB' });
    await settings.setSetting({ tenantId: TENANT_B, key: 'branding.locale', value: 'fr-FR' });
    await settings.clearSetting({ tenantId: TENANT_A, key: 'branding.locale' });

    expect(await settings.getSetting({ tenantId: TENANT_A, key: 'branding.locale' })).toBeNull();
    expect((await settings.getSetting({ tenantId: TENANT_B, key: 'branding.locale' }))?.value).toBe(
      'fr-FR',
    );
  });

  it('validates the key before deleting', async () => {
    await expect(settings.clearSetting({ tenantId: TENANT_A, key: 'locale' })).rejects.toThrow(
      SettingKeyError,
    );
    expect(queryService.calls).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it("keeps one tenant's settings invisible to another", async () => {
    await settings.setSetting({ tenantId: TENANT_A, key: 'branding.locale', value: 'en-GB' });
    await settings.setSetting({ tenantId: TENANT_B, key: 'branding.locale', value: 'fr-FR' });

    expect((await settings.getSetting({ tenantId: TENANT_A, key: 'branding.locale' }))?.value).toBe(
      'en-GB',
    );
    expect((await settings.getSetting({ tenantId: TENANT_B, key: 'branding.locale' }))?.value).toBe(
      'fr-FR',
    );
    expect(await settings.listSettings({ tenantId: TENANT_A })).toEqual([
      { key: 'branding.locale', value: 'en-GB', valueType: 'string' },
    ]);
  });

  it("passes the caller's tenant to every persistence call", async () => {
    await settings.setSetting({ tenantId: TENANT_B, key: 'branding.locale', value: 'fr-FR' });
    await settings.getSetting({ tenantId: TENANT_B, key: 'branding.locale' });
    await settings.listSettings({ tenantId: TENANT_B });
    expect(queryService.calls).toEqual([
      `upsertSetting(${TENANT_B}, branding.locale)`,
      `findSetting(${TENANT_B}, branding.locale)`,
      `listSettings(${TENANT_B})`,
    ]);
  });

  it('does not expose a setting seeded for another tenant', async () => {
    queryService.seedSetting(TENANT_B, {
      key: 'branding.locale',
      valueType: 'string',
      value: '"fr-FR"',
    });
    expect(await settings.listSettings({ tenantId: TENANT_A })).toEqual([]);
    expect(await settings.getSetting({ tenantId: TENANT_A, key: 'branding.locale' })).toBeNull();
  });
});
