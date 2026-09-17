/**
 * Setting and feature-flag key rules.
 *
 * Keys are dotted and namespaced so a key reads as what it configures and can
 * never collide across modules (Master Plan Section 60 uses
 * `feature.restaurant.v1`; the platform's own vocabulary adds `branding.locale`,
 * `booking.timezone`). Validation is strict and happens **before any query**:
 * the key ends up in a `where key = $1` predicate and in audit rows, so only the
 * canonical spelling may pass and two spellings can never address one setting.
 *
 * Case is not normalized on purpose - silently lowercasing would turn
 * `Branding.Locale` into a second address for `branding.locale`, which is
 * exactly the kind of alias that makes configuration unreviewable.
 */

import { SettingKeyError } from './errors.ts';

/** Longest accepted key, bounding the audit/event payload and the index entry. */
export const MAX_SETTING_KEY_LENGTH = 120;

/** Longest accepted single namespace segment (`branding`, `restaurant`, ...). */
export const MAX_SETTING_KEY_SEGMENT_LENGTH = 40;

/** Smallest accepted key: one namespace plus one name (`branding.locale`). */
export const MIN_SETTING_KEY_SEGMENTS = 2;

/**
 * One segment: lowercase alphanumerics, with `-`/`_` separators inside. Both
 * `feature.new-checkout` and `feature.restaurant.v1` are valid.
 */
const SEGMENT = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * A whole key: {@link MIN_SETTING_KEY_SEGMENTS} or more {@link SEGMENT}s joined
 * by dots, with no empty segment and no leading/trailing dot.
 */
export const SETTING_KEY_PATTERN =
  /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)+$/;

/** Non-throwing check, for callers that need a boolean instead of an exception. */
export function isValidSettingKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > MAX_SETTING_KEY_LENGTH) return false;
  const segments = key.split('.');
  if (segments.length < MIN_SETTING_KEY_SEGMENTS) return false;
  return segments.every(
    (segment) => segment.length <= MAX_SETTING_KEY_SEGMENT_LENGTH && SEGMENT.test(segment),
  );
}

/**
 * Validates a setting key and returns it unchanged.
 *
 * @throws {@link SettingKeyError} for an empty, malformed or over-long key.
 */
export function assertSettingKey(key: string): string {
  if (typeof key !== 'string' || key.trim() !== key || key.length === 0) {
    throw new SettingKeyError(
      `"${String(key).slice(0, 64)}" is not a valid setting key: expected a dotted, namespaced key with no surrounding whitespace.`,
    );
  }
  if (!isValidSettingKey(key)) {
    throw new SettingKeyError(
      `"${key.slice(0, 64)}" is not a valid setting key: expected ${MIN_SETTING_KEY_SEGMENTS}+ dot-separated lowercase segments of at most ${MAX_SETTING_KEY_SEGMENT_LENGTH} characters, e.g. "branding.locale" or "feature.restaurant.v1".`,
    );
  }
  return key;
}

/**
 * The namespace of a key - its first segment. Used to group settings for
 * review and to keep a module's configuration addressable as a unit.
 */
export function settingKeyNamespace(key: string): string {
  return assertSettingKey(key).split('.')[0] ?? '';
}
