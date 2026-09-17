/**
 * The errors `@slate/settings` raises for input the caller can fix.
 *
 * Every failure a request can cause is one of these (or a validation result);
 * nothing here is thrown for a *state* the platform owns, which is why the
 * unknown-flag case is deliberately absent: an undeclared flag resolves to
 * `false` instead of throwing (Master Plan Section 60, fail closed).
 */

const ERROR_PREFIX = '[slate/settings]';

/** Raised when a setting key does not match the dotted, namespaced convention. */
export class SettingKeyError extends Error {
  constructor(message: string) {
    super(`${ERROR_PREFIX} ${message}`);
    this.name = 'SettingKeyError';
  }
}

/** Raised when a value is not storable, or when a stored pair is inconsistent. */
export class SettingValueError extends Error {
  constructor(message: string) {
    super(`${ERROR_PREFIX} ${message}`);
    this.name = 'SettingValueError';
  }
}

/** Raised when a feature flag key is written but is not declared in the registry. */
export class FeatureFlagKeyError extends Error {
  constructor(message: string) {
    super(`${ERROR_PREFIX} ${message}`);
    this.name = 'FeatureFlagKeyError';
  }
}
