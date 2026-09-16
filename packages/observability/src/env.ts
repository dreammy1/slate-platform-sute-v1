/**
 * The environment contract of the observability baseline.
 *
 * Every reader takes the environment map as an argument instead of reaching for
 * `process.env` directly. That keeps configuration parsing pure and testable,
 * and it means a misconfiguration is reported as a thrown error from *this*
 * module - with the variable name in the message - instead of surfacing later
 * as a mysteriously missing log line or a silently dropped error report.
 *
 * Master Plan reference: Section 30 (Phase 1 environment configuration),
 * Section 61 (logging and monitoring rules).
 */

/** Environment map read by every helper in this package. */
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/** Authoritative environment name; falls back to `NODE_ENV`. */
export const SLATE_ENV_VARIABLE = 'SLATE_ENV';

/** Service identity attached to every log record and error report. */
export const SLATE_SERVICE_VARIABLE = 'SLATE_SERVICE';

/** Minimum level that is emitted (`debug`, `info`, `warn`, `error`). */
export const LOG_LEVEL_VARIABLE = 'LOG_LEVEL';

/** Record format (`json` for machines, `pretty` for a developer terminal). */
export const LOG_FORMAT_VARIABLE = 'LOG_FORMAT';

/** Error-monitoring DSN; an empty value disables error monitoring. */
export const SENTRY_DSN_VARIABLE = 'SENTRY_DSN';

/** Environment tag sent to the error monitor; defaults to `SLATE_ENV`. */
export const SENTRY_ENVIRONMENT_VARIABLE = 'SENTRY_ENVIRONMENT';

/** Release identifier (deployed tag or commit SHA) sent to the error monitor. */
export const SENTRY_RELEASE_VARIABLE = 'SENTRY_RELEASE';

/** Break-glass switch that turns error monitoring off while a DSN is configured. */
export const ERROR_MONITORING_DISABLED_VARIABLE = 'SLATE_DISABLE_ERROR_MONITORING';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ['json', 'pretty'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

/** Environments that behave like a developer machine (verbose, human-readable). */
export const LOCAL_ENVIRONMENTS = ['development', 'test'] as const;

/** Value used when neither `SLATE_ENV` nor `NODE_ENV` is set. */
export const DEFAULT_ENVIRONMENT = 'development';

/** Value used when `SLATE_SERVICE` is not set. */
export const DEFAULT_SERVICE_NAME = 'slate-platform';

/** Level used outside local development. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** Level used on a developer machine: everything is interesting there. */
export const LOCAL_LOG_LEVEL: LogLevel = 'debug';

/** Format used when the output is not an interactive terminal. */
export const DEFAULT_LOG_FORMAT: LogFormat = 'json';

const TRUTHY_VALUES = ['1', 'true', 'yes', 'on'] as const;
const FALSY_VALUES = ['0', 'false', 'no', 'off'] as const;

/** Reads a variable, treating an unset *or blank* value as "not configured". */
function readVariable(env: EnvironmentVariables, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function invalid(name: string, value: string, expected: string): Error {
  return new Error(
    `[slate/observability] ${name}="${value}" is invalid: expected ${expected}. Fix the value or remove the variable.`,
  );
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function isLogFormat(value: string): value is LogFormat {
  return (LOG_FORMATS as readonly string[]).includes(value);
}

/**
 * The configured environment name: `SLATE_ENV` first, then `NODE_ENV`, then
 * `development`. `SLATE_ENV` wins because a container usually runs with
 * `NODE_ENV=production` even when it is staging or a preview.
 */
export function slateEnvironment(env: EnvironmentVariables = process.env): string {
  return (
    readVariable(env, SLATE_ENV_VARIABLE) ?? readVariable(env, 'NODE_ENV') ?? DEFAULT_ENVIRONMENT
  );
}

/** `true` for `development` and `test`, i.e. for a developer machine. */
export function isLocalEnvironment(env: EnvironmentVariables = process.env): boolean {
  return (LOCAL_ENVIRONMENTS as readonly string[]).includes(slateEnvironment(env));
}

/** Service identity for log records and error reports. */
export function serviceName(env: EnvironmentVariables = process.env): string {
  return readVariable(env, SLATE_SERVICE_VARIABLE) ?? DEFAULT_SERVICE_NAME;
}

/** Error-monitoring environment tag; defaults to {@link slateEnvironment}. */
export function sentryEnvironment(env: EnvironmentVariables = process.env): string {
  return readVariable(env, SENTRY_ENVIRONMENT_VARIABLE) ?? slateEnvironment(env);
}

/** Deployed release identifier, or `undefined` when unknown. */
export function sentryRelease(env: EnvironmentVariables = process.env): string | undefined {
  return readVariable(env, SENTRY_RELEASE_VARIABLE);
}

/** Error-monitoring DSN, or `undefined` when blank (monitoring is then off). */
export function sentryDsn(env: EnvironmentVariables = process.env): string | undefined {
  return readVariable(env, SENTRY_DSN_VARIABLE);
}

/**
 * Whether error monitoring was explicitly switched off. Only the documented
 * boolean spellings are accepted: a typo must not read as "off" and quietly
 * disable monitoring in staging.
 */
export function errorMonitoringDisabled(env: EnvironmentVariables = process.env): boolean {
  const value = readVariable(env, ERROR_MONITORING_DISABLED_VARIABLE);
  if (value === undefined) {
    return false;
  }
  const normalized = value.toLowerCase();
  if ((TRUTHY_VALUES as readonly string[]).includes(normalized)) {
    return true;
  }
  if ((FALSY_VALUES as readonly string[]).includes(normalized)) {
    return false;
  }
  throw invalid(
    ERROR_MONITORING_DISABLED_VARIABLE,
    value,
    `one of ${TRUTHY_VALUES.join(', ')} or ${FALSY_VALUES.join(', ')}`,
  );
}

/** Minimum level that is emitted; local development defaults to `debug`. */
export function resolveLogLevel(env: EnvironmentVariables = process.env): LogLevel {
  const configured = readVariable(env, LOG_LEVEL_VARIABLE);
  if (configured === undefined) {
    return isLocalEnvironment(env) ? LOCAL_LOG_LEVEL : DEFAULT_LOG_LEVEL;
  }
  if (!isLogLevel(configured)) {
    throw invalid(LOG_LEVEL_VARIABLE, configured, LOG_LEVELS.join(', '));
  }
  return configured;
}

/**
 * Record format: an explicit `LOG_FORMAT` always wins; otherwise an interactive
 * terminal in local development gets `pretty`, and everything else (CI, a
 * container, a log collector) gets `json`.
 */
export function resolveLogFormat(
  env: EnvironmentVariables = process.env,
  isTty = false,
): LogFormat {
  const configured = readVariable(env, LOG_FORMAT_VARIABLE);
  if (configured === undefined) {
    return isTty && isLocalEnvironment(env) ? 'pretty' : DEFAULT_LOG_FORMAT;
  }
  if (!isLogFormat(configured)) {
    throw invalid(LOG_FORMAT_VARIABLE, configured, LOG_FORMATS.join(', '));
  }
  return configured;
}
