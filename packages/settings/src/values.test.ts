import { describe, expect, it } from 'vitest';

import { SettingValueError } from './errors.ts';
import {
  MAX_SETTING_JSON_DEPTH,
  MAX_SETTING_STRING_LENGTH,
  SETTING_VALUE_TYPES,
  assertSettingValue,
  isSettingValueType,
  parseStoredSettingValue,
  toJsonbText,
  typeOfSettingValue,
} from './values.ts';

describe('typeOfSettingValue', () => {
  it.each([
    ['en-GB', 'string'],
    ['', 'string'],
    [0, 'number'],
    [-1.5, 'number'],
    [true, 'boolean'],
    [false, 'boolean'],
    [{ locale: 'en-GB', nested: { enabled: true } }, 'json'],
    [[1, 'two', null, { three: 3 }], 'json'],
  ])('classifies %j as %s', (value, expected) => {
    expect(typeOfSettingValue(value)).toBe(expected);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a function', () => 'nope'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a Date', new Date('2026-09-17T00:00:00Z')],
    ['a class instance', new (class Widget {})()],
    ['a Map', new Map([['a', 1]])],
    ['a Symbol', Symbol('s')],
    ['a BigInt', 10n],
    ['a nested function', { handler: () => undefined }],
    ['a nested undefined', { missing: undefined }],
  ])('refuses to classify %s', (_label, value) => {
    expect(typeOfSettingValue(value)).toBeUndefined();
  });

  it('bounds string length', () => {
    expect(typeOfSettingValue('a'.repeat(MAX_SETTING_STRING_LENGTH))).toBe('string');
    expect(typeOfSettingValue('a'.repeat(MAX_SETTING_STRING_LENGTH + 1))).toBeUndefined();
  });

  it('bounds JSON nesting depth', () => {
    const nest = (levels: number): unknown => {
      let value: unknown = 'leaf';
      for (let index = 0; index < levels; index += 1) value = { next: value };
      return value;
    };
    expect(typeOfSettingValue(nest(MAX_SETTING_JSON_DEPTH))).toBe('json');
    expect(typeOfSettingValue(nest(MAX_SETTING_JSON_DEPTH + 2))).toBeUndefined();
  });
});

describe('assertSettingValue', () => {
  it('returns a storable value unchanged', () => {
    const value = { locale: 'en-GB' };
    expect(assertSettingValue(value)).toBe(value);
    expect(assertSettingValue('en-GB')).toBe('en-GB');
    expect(assertSettingValue(42)).toBe(42);
  });

  it('explains what is storable instead of storing a coercion', () => {
    expect(() => assertSettingValue(new Date())).toThrow(SettingValueError);
    expect(() => assertSettingValue(new Date())).toThrow(/not storable/);
  });
});

describe('toJsonbText', () => {
  it('always produces JSON, including for a bare string', () => {
    // `jsonb` input is parsed as JSON: a raw `en-GB` would be rejected.
    expect(toJsonbText('en-GB')).toBe('"en-GB"');
    expect(toJsonbText(true)).toBe('true');
    expect(toJsonbText(42)).toBe('42');
    expect(toJsonbText({ a: 1 })).toBe('{"a":1}');
  });

  it('round-trips every value type without changing its type', () => {
    const values = ['en-GB', 0, 42, -1.5, true, false, { a: [1, 'two', null] }, [], [1, 2]];
    for (const value of values) {
      const restored: unknown = JSON.parse(toJsonbText(value as never));
      expect(restored).toEqual(value);
      expect(typeOfSettingValue(restored)).toBe(typeOfSettingValue(value));
    }
  });
});

describe('parseStoredSettingValue', () => {
  it.each(SETTING_VALUE_TYPES)('accepts a %s row that agrees with its value', (valueType) => {
    const stored: Record<string, unknown> = {
      string: 'en-GB',
      number: 42,
      boolean: true,
      json: { locale: 'en-GB' },
    };
    const value = stored[valueType];
    expect(parseStoredSettingValue(valueType, value)).toEqual(value);
  });

  it('refuses a discriminator that disagrees with the stored value', () => {
    // PostgreSQL returns parsed jsonb, so a number arrives as a number: a row
    // claiming `string` is corrupt and must not be served as if it were valid.
    expect(() => parseStoredSettingValue('string', 42)).toThrow(SettingValueError);
    expect(() => parseStoredSettingValue('number', '42')).toThrow(
      /disagrees with the stored value/,
    );
    expect(() => parseStoredSettingValue('boolean', 'true')).toThrow(SettingValueError);
    expect(() => parseStoredSettingValue('json', 'plain')).toThrow(SettingValueError);
  });

  it('refuses an unknown discriminator', () => {
    expect(() => parseStoredSettingValue('uuid', 'abc')).toThrow(SettingValueError);
    expect(() => parseStoredSettingValue('uuid', 'abc')).toThrow(/not one of/);
  });
});

describe('isSettingValueType', () => {
  it('narrows only the declared discriminators', () => {
    for (const valueType of SETTING_VALUE_TYPES) expect(isSettingValueType(valueType)).toBe(true);
    expect(isSettingValueType('uuid')).toBe(false);
    expect(isSettingValueType('')).toBe(false);
  });
});
