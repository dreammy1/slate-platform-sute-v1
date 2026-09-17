import { describe, expect, it } from 'vitest';

import { SettingKeyError } from './errors.ts';
import {
  MAX_SETTING_KEY_LENGTH,
  MAX_SETTING_KEY_SEGMENT_LENGTH,
  assertSettingKey,
  isValidSettingKey,
  settingKeyNamespace,
} from './keys.ts';

describe('isValidSettingKey', () => {
  it.each([
    'branding.locale',
    'booking.timezone',
    'feature.restaurant.v1',
    'feature.new-checkout',
    'feature.ai.assistant',
    'a.b',
    'crm.pipeline_stages',
    'auth.2fa_required',
  ])('accepts the canonical namespaced key %s', (key) => {
    expect(isValidSettingKey(key)).toBe(true);
  });

  it.each([
    'locale',
    '.branding.locale',
    'branding.locale.',
    'branding..locale',
    'Branding.Locale',
    'branding. locale',
    ' branding.locale',
    'branding.locale ',
    'branding.locale!',
    'branding-locale',
    'branding.-locale',
    '',
  ])('rejects the malformed key %j', (key) => {
    expect(isValidSettingKey(key)).toBe(false);
  });

  it('rejects a key that is too long', () => {
    const longSegment = 'a'.repeat(MAX_SETTING_KEY_SEGMENT_LENGTH + 1);
    expect(isValidSettingKey(`branding.${longSegment}`)).toBe(false);
    const longKey = `${'a'.repeat(MAX_SETTING_KEY_SEGMENT_LENGTH)}.${'b'.repeat(
      MAX_SETTING_KEY_LENGTH,
    )}`;
    expect(isValidSettingKey(longKey)).toBe(false);
  });
});

describe('assertSettingKey', () => {
  it('returns the key unchanged when it is canonical', () => {
    expect(assertSettingKey('feature.restaurant.v1')).toBe('feature.restaurant.v1');
  });

  it('fails loudly and names the expected shape', () => {
    expect(() => assertSettingKey('locale')).toThrow(SettingKeyError);
    expect(() => assertSettingKey('locale')).toThrow(/not a valid setting key/);
    expect(() => assertSettingKey('locale')).toThrow(/branding\.locale/);
  });

  it('does not silently normalize case or whitespace', () => {
    // Two spellings must never address one setting, so nothing is rewritten.
    expect(() => assertSettingKey('Branding.Locale')).toThrow(SettingKeyError);
    expect(() => assertSettingKey(' branding.locale ')).toThrow(SettingKeyError);
  });
});

describe('settingKeyNamespace', () => {
  it('groups keys by their first segment', () => {
    expect(settingKeyNamespace('branding.locale')).toBe('branding');
    expect(settingKeyNamespace('feature.restaurant.v1')).toBe('feature');
  });

  it('validates before answering', () => {
    expect(() => settingKeyNamespace('locale')).toThrow(SettingKeyError);
  });
});
