/**
 * Setting values: one JSON-compatible shape, stored with an explicit type.
 *
 * A setting is stored as `jsonb` **plus** a `value_type` discriminator, and both
 * directions of the trip are validated here:
 *
 * - **write** ({@link assertSettingValue} + {@link toJsonbText}) - only
 *   JSON-compatible values are accepted, so a stored value can never be
 *   something the read path cannot reconstruct.
 * - **read** ({@link parseStoredSettingValue}) - the discriminator is checked
 *   against the actual stored value, so a row corrupted outside this package
 *   fails loudly instead of being served with the wrong type.
 *
 * That is what makes a value round-trip with the type it was written with: a
 * number never comes back as the string `"42"`, and a boolean never comes back
 * as `"true"`.
 *
 * Values are always written through {@link toJsonbText} (a JSON string). Passing
 * a raw JavaScript string to a `jsonb` column would be sent as bare text and
 * rejected by PostgreSQL as invalid JSON, so serializing here is a correctness
 * requirement, not a convenience.
 */

import { SettingValueError } from './errors.ts';

/** The `value_type` discriminator values this package writes. */
export type SettingValueType = 'string' | 'number' | 'boolean' | 'json';

/** Every value type, for iteration in tests and error messages. */
export const SETTING_VALUE_TYPES = ['string', 'number', 'boolean', 'json'] as const;

/** Longest accepted string value; bounds storage and any audit payload. */
export const MAX_SETTING_STRING_LENGTH = 8192;

/** Deepest accepted JSON nesting; keeps a value reviewable and cheap to copy. */
export const MAX_SETTING_JSON_DEPTH = 8;

/** A JSON object: string keys, JSON values. */
export interface SettingJsonObject {
  readonly [key: string]: SettingJson;
}

/** A JSON array. */
export type SettingJsonArray = readonly SettingJson[];

/** Any value JSON itself can represent. */
export type SettingJson = string | number | boolean | null | SettingJsonObject | SettingJsonArray;

/** A storable setting value: a JSON scalar, or a JSON object/array for `json`. */
export type SettingValue = string | number | boolean | SettingJsonObject | SettingJsonArray;

/** A setting as it is handed back to callers. */
export interface SettingRecord {
  /** The dotted, namespaced key. */
  readonly key: string;
  /** The value, with the type it was written with. */
  readonly value: SettingValue;
  /** Discriminator stored alongside the value. */
  readonly valueType: SettingValueType;
}

/** Narrows an arbitrary string to a {@link SettingValueType}. */
export function isSettingValueType(value: string): value is SettingValueType {
  return (SETTING_VALUE_TYPES as readonly string[]).includes(value);
}

/**
 * The {@link SettingValueType} a candidate value belongs to, or `undefined` when
 * the value is not storable (null, undefined, a function, a class instance, a
 * non-finite number, a cyclic structure, ...).
 */
export function typeOfSettingValue(value: unknown): SettingValueType | undefined {
  switch (typeof value) {
    case 'string':
      return value.length <= MAX_SETTING_STRING_LENGTH ? 'string' : undefined;
    case 'number':
      return Number.isFinite(value) ? 'number' : undefined;
    case 'boolean':
      return 'boolean';
    case 'object':
      return value === null ? undefined : isJsonCompatible(value, 0) ? 'json' : undefined;
    default:
      return undefined;
  }
}

/**
 * Validates a value for storage and returns it unchanged.
 *
 * @throws {@link SettingValueError} when the value is not JSON-compatible, is
 *   too long, or nests deeper than {@link MAX_SETTING_JSON_DEPTH}.
 */
export function assertSettingValue(value: unknown): SettingValue {
  const valueType = typeOfSettingValue(value);
  if (valueType === undefined) {
    throw new SettingValueError(
      `value of type "${describeValue(value)}" is not storable: expected a string of at most ${MAX_SETTING_STRING_LENGTH} characters, a finite number, a boolean, or a JSON object/array nested no deeper than ${MAX_SETTING_JSON_DEPTH} levels.`,
    );
  }
  return value as SettingValue;
}

/**
 * Serializes a validated value for a `jsonb` column.
 *
 * Always produces JSON text: `jsonb` input is parsed as JSON, so a bare
 * `en-GB` would be rejected while `"en-GB"` is a valid JSON string.
 */
export function toJsonbText(value: SettingValue): string {
  return JSON.stringify(value);
}

/**
 * Reconstructs a stored `(value_type, value)` pair.
 *
 * @throws {@link SettingValueError} when the discriminator is unknown or
 *   disagrees with the stored value - a data integrity fault in the tenant's
 *   configuration row, which must never be served as if it were valid.
 */
export function parseStoredSettingValue(valueType: string, value: unknown): SettingRecord['value'] {
  if (!isSettingValueType(valueType)) {
    throw new SettingValueError(
      `stored value_type "${valueType.slice(0, 32)}" is not one of: ${SETTING_VALUE_TYPES.join(', ')}.`,
    );
  }
  const actual = typeOfSettingValue(value);
  if (actual !== valueType) {
    throw new SettingValueError(
      `stored value_type "${valueType}" disagrees with the stored value (${actual ?? 'unstorable'}); refusing to serve an inconsistent setting.`,
    );
  }
  return value as SettingValue;
}

/** Human-readable shape of a rejected value, for error messages only. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'Date';
  const type = typeof value;
  if (type !== 'object') return type;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return 'object';
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name === undefined || name === '' ? 'object' : name;
}

/**
 * JSON-compatibility check: plain objects, arrays and JSON scalars only.
 *
 * `Date`, `Map`, class instances, functions and `undefined` are rejected rather
 * than coerced, because serializing them would store a value whose type no
 * longer matches the discriminator.
 */
function isJsonCompatible(value: unknown, depth: number): boolean {
  if (depth > MAX_SETTING_JSON_DEPTH) return false;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (value === null) return true;
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonCompatible(entry, depth + 1));
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  return Object.values(value as Record<string, unknown>).every((entry) =>
    isJsonCompatible(entry, depth + 1),
  );
}
