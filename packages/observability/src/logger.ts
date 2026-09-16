import {
  resolveLogFormat,
  resolveLogLevel,
  sentryRelease,
  serviceName,
  slateEnvironment,
  type EnvironmentVariables,
  type LogFormat,
  type LogLevel,
} from './env.ts';
import { redactValue, scrubSecrets, type RedactOptions } from './redact.ts';

/**
 * The structured logging baseline.
 *
 * A record is a flat, JSON-serializable object with fixed leading fields
 * (`level`, `time`, `msg`, `service`, `environment`, `release`) followed by the
 * context of the call. One shape everywhere is what makes logs queryable: a log
 * collector can index `service`, `environment`, `level` and `msg` for every app
 * in the platform without per-app parsing rules.
 *
 * Master Plan reference: Section 61 (structured logging, no sensitive data in
 * logs, correlation of errors with releases).
 */

/** Contextual fields; keys are free-form but the reserved ones are ignored. */
export type LogContext = Readonly<Record<string, unknown>>;

/** A complete log record, as written to the sink. */
export interface LogFields {
  readonly level: LogLevel;
  readonly time: string;
  readonly msg: string;
  readonly service: string;
  readonly environment: string;
  readonly release?: string;
  readonly [key: string]: unknown;
}

/**
 * Destination of a formatted record. The default writes JSON lines to stdout
 * (and `warn`/`error` to stderr); tests and embedding applications inject their
 * own sink instead.
 */
export type LogSink = (line: string, record: LogFields) => void;

/**
 * Fields owned by the logger. A binding or a context key with one of these
 * names is dropped, so application data can never overwrite the level, the
 * timestamp or the service identity.
 */
export const RESERVED_LOG_FIELDS = [
  'level',
  'time',
  'msg',
  'service',
  'environment',
  'release',
] as const;

const RESERVED_FIELD_SET: ReadonlySet<string> = new Set<string>(RESERVED_LOG_FIELDS);

const LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_LABELS: Readonly<Record<LogLevel, string>> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

/** Writes one line per record: `info`/`debug` to stdout, `warn`/`error` to stderr. */
export const DEFAULT_SINK: LogSink = (line, record) => {
  const stream =
    record.level === 'warn' || record.level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

/** A value that can be written without quoting in the pretty format. */
const PRETTY_PLAIN_VALUE = /^[^\s"\\=]+$/;

function formatPrettyValue(value: unknown): string {
  if (typeof value === 'string') {
    return PRETTY_PLAIN_VALUE.test(value) ? value : JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Human-readable single line, for a developer terminal only. */
export function formatLogRecordPretty(record: LogFields): string {
  const { level, time, msg, service, environment, release, ...context } = record;
  const parts = [time, LEVEL_LABELS[level], service, environment];

  if (release !== undefined) {
    parts.push(release);
  }
  parts.push(msg);

  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${formatPrettyValue(value)}`);
  }

  return parts.join(' ');
}

/** Formats a record for the configured target (`json` by default). */
export function formatLogRecord(record: LogFields, format: LogFormat = 'json'): string {
  return format === 'pretty' ? formatLogRecordPretty(record) : JSON.stringify(record);
}

/** Options accepted by {@link createLogger}. Everything is injectable for tests. */
export interface LoggerOptions {
  /** Defaults to `SLATE_SERVICE`, then `slate-platform`. */
  readonly service?: string | undefined;
  /** Defaults to `SLATE_ENV`, then `NODE_ENV`, then `development`. */
  readonly environment?: string | undefined;
  /** Defaults to `SENTRY_RELEASE`; omitted from records when unknown. */
  readonly release?: string | undefined;
  /** Defaults to `LOG_LEVEL`, which itself defaults per environment. */
  readonly level?: LogLevel | undefined;
  /** Defaults to `LOG_FORMAT`, which itself defaults per environment/terminal. */
  readonly format?: LogFormat | undefined;
  /** Fields attached to every record, e.g. `{ tenantId, requestId }`. */
  readonly bindings?: LogContext | undefined;
  /** Defaults to {@link DEFAULT_SINK}. */
  readonly sink?: LogSink | undefined;
  /** Clock, injectable so record timestamps are deterministic in tests. */
  readonly now?: (() => Date) | undefined;
  /** Redaction overrides; see {@link RedactOptions}. */
  readonly redact?: RedactOptions | undefined;
  /** Environment map; defaults to `process.env`. */
  readonly env?: EnvironmentVariables | undefined;
  /** Whether the sink is an interactive terminal; defaults to `process.stdout.isTTY`. */
  readonly isTty?: boolean | undefined;
}

/** Structured logger: one record shape, one redaction path, one sink. */
export interface Logger {
  readonly service: string;
  readonly environment: string;
  readonly release: string | undefined;
  readonly level: LogLevel;
  readonly format: LogFormat;
  /** Fields attached to every record this logger writes. */
  readonly bindings: LogContext;
  /** `true` when a record at `level` would be written. */
  isEnabled(level: LogLevel): boolean;
  /** Derives a logger whose records carry `bindings` (child wins over parent). */
  child(bindings: LogContext): Logger;
  /** Writes a record at an explicit level, e.g. from a bridge or middleware. */
  log(level: LogLevel, message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  /**
   * Records a failure. Pass the error in the context under `err` - the value is
   * serialized ({@link serializeError}) and redacted like any other field:
   *
   * ```ts
   * logger.error('payment capture failed', { err, orderId });
   * ```
   */
  error(message: string, context?: LogContext): void;
}

interface LoggerState {
  readonly service: string;
  readonly environment: string;
  readonly release: string | undefined;
  readonly level: LogLevel;
  readonly format: LogFormat;
  readonly sink: LogSink;
  readonly now: () => Date;
  readonly redact: RedactOptions;
  readonly bindings: LogContext;
}

/** Removes the fields the logger owns, so context can never overwrite them. */
function dropReservedFields(bindings: LogContext): LogContext {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (RESERVED_FIELD_SET.has(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function createLoggerWithState(state: LoggerState): Logger {
  function write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[state.level]) {
      return;
    }

    const redacted = redactValue(
      { ...state.bindings, ...dropReservedFields(context ?? {}) },
      state.redact,
    ) as Record<string, unknown>;

    const record: LogFields = {
      level,
      time: state.now().toISOString(),
      // Messages are scrubbed like any other string: a connection string or a
      // bearer token pasted into a message is the most common accidental leak.
      msg: state.redact.scrubStrings === false ? message : scrubSecrets(message),
      service: state.service,
      environment: state.environment,
      ...(state.release === undefined ? {} : { release: state.release }),
      ...redacted,
    };

    state.sink(formatLogRecord(record, state.format), record);
  }

  return {
    service: state.service,
    environment: state.environment,
    release: state.release,
    level: state.level,
    format: state.format,
    bindings: state.bindings,

    isEnabled(level) {
      return LEVEL_SEVERITY[level] >= LEVEL_SEVERITY[state.level];
    },

    child(bindings) {
      return createLoggerWithState({
        ...state,
        bindings: dropReservedFields({ ...state.bindings, ...bindings }),
      });
    },

    // Method properties (not `this`-dependent methods) so a destructured
    // `const { info } = logger` keeps working.
    log: write,
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  };
}

/**
 * Creates the platform logger. Configuration is read from the environment
 * (`SLATE_SERVICE`, `SLATE_ENV`, `LOG_LEVEL`, `LOG_FORMAT`, `SENTRY_RELEASE`)
 * unless an option overrides it; an invalid `LOG_LEVEL` or `LOG_FORMAT` throws
 * instead of silently falling back.
 *
 * @example
 * ```ts
 * const logger = createLogger({ bindings: { requestId } });
 * logger.info('order confirmed', { orderId });
 * logger.error('capture failed', { err, orderId });
 * ```
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const env = options.env ?? process.env;

  return createLoggerWithState({
    service: options.service ?? serviceName(env),
    environment: options.environment ?? slateEnvironment(env),
    release: options.release ?? sentryRelease(env),
    level: options.level ?? resolveLogLevel(env),
    format: options.format ?? resolveLogFormat(env, options.isTty ?? Boolean(process.stdout.isTTY)),
    sink: options.sink ?? DEFAULT_SINK,
    now: options.now ?? ((): Date => new Date()),
    redact: options.redact ?? {},
    bindings: dropReservedFields(options.bindings ?? {}),
  });
}
