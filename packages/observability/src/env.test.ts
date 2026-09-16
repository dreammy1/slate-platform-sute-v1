import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENVIRONMENT,
  DEFAULT_LOG_FORMAT,
  DEFAULT_LOG_LEVEL,
  DEFAULT_SERVICE_NAME,
  ERROR_MONITORING_DISABLED_VARIABLE,
  LOCAL_LOG_LEVEL,
  LOG_FORMAT_VARIABLE,
  LOG_LEVEL_VARIABLE,
  SENTRY_DSN_VARIABLE,
  SENTRY_ENVIRONMENT_VARIABLE,
  SENTRY_RELEASE_VARIABLE,
  SLATE_ENV_VARIABLE,
  SLATE_SERVICE_VARIABLE,
  errorMonitoringDisabled,
  isLocalEnvironment,
  isLogFormat,
  isLogLevel,
  resolveLogFormat,
  resolveLogLevel,
  sentryDsn,
  sentryEnvironment,
  sentryRelease,
  serviceName,
  slateEnvironment,
} from './env.ts';

describe('slateEnvironment', () => {
  it('prefers SLATE_ENV over NODE_ENV', () => {
    expect(slateEnvironment({ [SLATE_ENV_VARIABLE]: 'staging', NODE_ENV: 'production' })).toBe(
      'staging',
    );
  });

  it('falls back to NODE_ENV and then to the default environment', () => {
    expect(slateEnvironment({ NODE_ENV: 'production' })).toBe('production');
    expect(slateEnvironment({})).toBe(DEFAULT_ENVIRONMENT);
  });

  it('treats an unset or blank value as not configured', () => {
    expect(slateEnvironment({ [SLATE_ENV_VARIABLE]: '   ' })).toBe(DEFAULT_ENVIRONMENT);
    expect(slateEnvironment({ [SLATE_ENV_VARIABLE]: ' staging ' })).toBe('staging');
  });
});

describe('isLocalEnvironment', () => {
  it('is true only for development and test', () => {
    expect(isLocalEnvironment({ [SLATE_ENV_VARIABLE]: 'development' })).toBe(true);
    expect(isLocalEnvironment({ [SLATE_ENV_VARIABLE]: 'test' })).toBe(true);
    expect(isLocalEnvironment({ [SLATE_ENV_VARIABLE]: 'staging' })).toBe(false);
    expect(isLocalEnvironment({ [SLATE_ENV_VARIABLE]: 'production' })).toBe(false);
  });
});

describe('serviceName', () => {
  it('defaults to the platform name and honours SLATE_SERVICE', () => {
    expect(serviceName({})).toBe(DEFAULT_SERVICE_NAME);
    expect(serviceName({ [SLATE_SERVICE_VARIABLE]: 'slate-api' })).toBe('slate-api');
    expect(serviceName({ [SLATE_SERVICE_VARIABLE]: '  ' })).toBe(DEFAULT_SERVICE_NAME);
  });
});

describe('error-monitoring readers', () => {
  it('derives the monitor environment from SLATE_ENV', () => {
    expect(sentryEnvironment({ [SLATE_ENV_VARIABLE]: 'staging' })).toBe('staging');
    expect(sentryEnvironment({ [SENTRY_ENVIRONMENT_VARIABLE]: 'staging-eu' })).toBe('staging-eu');
  });

  it('keeps release and DSN optional', () => {
    expect(sentryRelease({})).toBeUndefined();
    expect(sentryRelease({ [SENTRY_RELEASE_VARIABLE]: 'a1b2c3d' })).toBe('a1b2c3d');
    expect(sentryDsn({ [SENTRY_DSN_VARIABLE]: '' })).toBeUndefined();
    expect(sentryDsn({ [SENTRY_DSN_VARIABLE]: 'https://key@host/1' })).toBe('https://key@host/1');
  });
});

describe('resolveLogLevel', () => {
  it('defaults to verbose locally and to info elsewhere', () => {
    expect(resolveLogLevel({})).toBe(LOCAL_LOG_LEVEL);
    expect(resolveLogLevel({ [SLATE_ENV_VARIABLE]: 'production' })).toBe(DEFAULT_LOG_LEVEL);
  });

  it('honours LOG_LEVEL and rejects a typo instead of falling back', () => {
    expect(resolveLogLevel({ [LOG_LEVEL_VARIABLE]: 'warn' })).toBe('warn');
    expect(() => resolveLogLevel({ [LOG_LEVEL_VARIABLE]: 'verbose' })).toThrow(
      /LOG_LEVEL="verbose" is invalid: expected debug, info, warn, error/,
    );
  });
});

describe('resolveLogFormat', () => {
  it('defaults to json and to pretty only on a local terminal', () => {
    expect(resolveLogFormat({})).toBe(DEFAULT_LOG_FORMAT);
    expect(resolveLogFormat({}, true)).toBe('pretty');
    expect(resolveLogFormat({ [SLATE_ENV_VARIABLE]: 'production' }, true)).toBe('json');
  });

  it('lets LOG_FORMAT override the default and rejects unknown formats', () => {
    expect(resolveLogFormat({ [LOG_FORMAT_VARIABLE]: 'pretty' })).toBe('pretty');
    expect(resolveLogFormat({ [LOG_FORMAT_VARIABLE]: 'json' }, true)).toBe('json');
    expect(() => resolveLogFormat({ [LOG_FORMAT_VARIABLE]: 'xml' })).toThrow(
      /LOG_FORMAT="xml" is invalid: expected json, pretty/,
    );
  });
});

describe('errorMonitoringDisabled', () => {
  it('accepts the documented spellings', () => {
    expect(errorMonitoringDisabled({})).toBe(false);
    expect(errorMonitoringDisabled({ [ERROR_MONITORING_DISABLED_VARIABLE]: 'TRUE' })).toBe(true);
    expect(errorMonitoringDisabled({ [ERROR_MONITORING_DISABLED_VARIABLE]: 'on' })).toBe(true);
    expect(errorMonitoringDisabled({ [ERROR_MONITORING_DISABLED_VARIABLE]: 'off' })).toBe(false);
  });

  it('refuses an ambiguous value rather than reading it as off', () => {
    expect(() =>
      errorMonitoringDisabled({ [ERROR_MONITORING_DISABLED_VARIABLE]: 'maybe' }),
    ).toThrow(/SLATE_DISABLE_ERROR_MONITORING="maybe" is invalid/);
  });
});

describe('isLogLevel and isLogFormat', () => {
  it('guard the unions case-sensitively', () => {
    expect(isLogLevel('error')).toBe(true);
    expect(isLogLevel('fatal')).toBe(false);
    expect(isLogLevel('INFO')).toBe(false);
    expect(isLogFormat('json')).toBe(true);
    expect(isLogFormat('pretty')).toBe(true);
    expect(isLogFormat('JSON')).toBe(false);
  });
});
