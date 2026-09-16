import { randomUUID } from 'node:crypto';

import {
  ERROR_MONITORING_DISABLED_VARIABLE,
  SENTRY_DSN_VARIABLE,
  errorMonitoringDisabled,
  sentryDsn,
  sentryEnvironment,
  sentryRelease,
  serviceName,
  type EnvironmentVariables,
} from './env.ts';
import { serializeError } from './errors.ts';
import type { LogContext, Logger } from './logger.ts';
import { redactValue, scrubSecrets, type RedactOptions } from './redact.ts';

/**
 * Error monitoring without a vendor SDK.
 *
 * A failure nobody ever sees is a failure that never happened, so error
 * reporting exists from the first phase. Instead of depending on a vendor agent
 * (which would own the process, the request lifecycle and the dependency graph),
 * this module speaks the *public Sentry envelope protocol* over plain `fetch`,
 * which keeps three properties:
 *
 * - no runtime dependency, no auto-instrumentation, no global patching;
 * - the payload is inspectable and testable byte for byte;
 * - the transport is injectable, so tests never touch the network and a future
 *   self-hosted collector only needs a different DSN.
 */

/** Name reported in the `sdk` field of every event. */
export const SDK_NAME = 'slate-observability';

/** Must stay in sync with the `version` field of this workspace's package.json. */
export const SDK_VERSION = '0.1.0';

/** Content type of a Sentry envelope request body. */
export const SENTRY_ENVELOPE_CONTENT_TYPE = 'application/x-sentry-envelope';

/** Events kept in flight before new ones are dropped (never unbounded). */
export const DEFAULT_MAX_PENDING_EVENTS = 20;

/** How long {@link ErrorMonitor.flush} waits before giving up. */
export const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

/** Frames kept per stack trace; a 500-frame stack is noise, not information. */
export const MAX_STACK_FRAMES = 50;

const PROJECT_ID_PATTERN = /^[0-9]+$/;

/** A parsed error-monitoring DSN. */
export interface SentryDsn {
  /** The DSN as configured. */
  readonly dsn: string;
  readonly scheme: string;
  /** Public key, sent as `sentry_key` in the authentication header. */
  readonly publicKey: string;
  /** Host (with port when present). */
  readonly host: string;
  /** Path between the host and the project id, `''` when there is none. */
  readonly prefix: string;
  readonly projectId: string;
  /** Fully qualified envelope endpoint. */
  readonly envelopeUrl: string;
  /** `X-Sentry-Auth` header value. */
  readonly authHeader: string;
}

/**
 * Parses `https://<public-key>@<host>[/<prefix>]/<project-id>`.
 *
 * A malformed DSN throws at startup: silently disabling monitoring because of a
 * typo is exactly the failure mode this baseline must not have.
 */
export function parseSentryDsn(dsn: string): SentryDsn {
  const trimmed = dsn.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `[slate/observability] "${dsn}" is not a valid error-monitoring DSN: expected a URL such as "https://<public-key>@o0.ingest.sentry.io/1".`,
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `[slate/observability] the error-monitoring DSN must use http or https, received "${url.protocol}".`,
    );
  }
  if (url.username === '') {
    throw new Error(
      '[slate/observability] the error-monitoring DSN is missing its public key (the part before "@").',
    );
  }

  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const projectId = segments.at(-1);
  if (projectId === undefined) {
    throw new Error(
      '[slate/observability] the error-monitoring DSN is missing its project id (the last path segment).',
    );
  }
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(
      `[slate/observability] the error-monitoring DSN must end with a numeric project id, received "${projectId}".`,
    );
  }

  const scheme = url.protocol.replace(':', '');
  const { host, username } = url;
  const path = segments.slice(0, -1).join('/');
  const prefix = path === '' ? '' : `/${path}`;
  const publicKey = decodeURIComponent(username);

  return {
    dsn: trimmed,
    scheme,
    publicKey,
    host,
    prefix,
    projectId,
    envelopeUrl: `${scheme}://${host}${prefix}/api/${projectId}/envelope/`,
    authHeader: `Sentry sentry_version=7, sentry_client=${SDK_NAME}/${SDK_VERSION}, sentry_key=${publicKey}`,
  };
}
/** A fresh 32-character hexadecimal event id, as the protocol requires. */
export function createEventId(): string {
  return randomUUID().replaceAll('-', '');
}

/** One stack frame in Sentry's shape. */
export interface SentryFrame {
  readonly filename: string;
  readonly function?: string;
  readonly lineno?: number;
  readonly colno?: number;
}

const STACK_FRAME_PATTERN = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * Parses a V8 stack into Sentry frames, oldest first (the order Sentry
 * displays) and capped at {@link MAX_STACK_FRAMES}.
 */
export function parseStackFrames(stack: string): SentryFrame[] {
  const frames: SentryFrame[] = [];

  for (const line of stack.split('\n')) {
    const match = STACK_FRAME_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const functionName = match[1];
    const filename = match[2];
    const lineno = match[3];
    const colno = match[4];
    if (filename === undefined) {
      continue;
    }

    const frame: {
      filename: string;
      function?: string;
      lineno?: number;
      colno?: number;
    } = { filename };
    if (functionName !== undefined && functionName !== '') {
      frame.function = functionName;
    }
    if (lineno !== undefined) {
      frame.lineno = Number(lineno);
    }
    if (colno !== undefined) {
      frame.colno = Number(colno);
    }
    frames.push(frame);
  }
  return frames.slice(0, MAX_STACK_FRAMES).reverse();
}

/** Severity levels understood by the protocol. */
export const SENTRY_EVENT_LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'] as const;
export type SentryEventLevel = (typeof SENTRY_EVENT_LEVELS)[number];

export interface SentryExceptionValue {
  readonly type: string;
  readonly value: string;
  readonly stacktrace?: { readonly frames: readonly SentryFrame[] };
}

/** The subset of the Sentry event schema this baseline produces. */
export interface SentryEvent {
  readonly event_id: string;
  readonly timestamp: string;
  readonly platform: 'node';
  readonly level: SentryEventLevel;
  readonly sdk: { readonly name: string; readonly version: string };
  readonly logger?: string;
  readonly environment?: string;
  readonly release?: string;
  readonly message?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly exception?: { readonly values: readonly SentryExceptionValue[] };
}

export interface SentryEnvelopeHeader {
  readonly event_id: string;
  readonly dsn: string;
  readonly sent_at: string;
}

/**
 * Builds the three-line Sentry envelope: header, item header, event.
 *
 * `dsn` in the header is what lets a relay route the event without inspecting
 * the body, and `sent_at` is the envelope time (the event carries its own).
 */
export function buildSentryEnvelope(
  event: SentryEvent,
  dsn: string,
  sentAt: Date = new Date(),
): string {
  const header: SentryEnvelopeHeader = {
    event_id: event.event_id,
    dsn,
    sent_at: sentAt.toISOString(),
  };
  const item = { type: 'event', content_type: 'application/json' };

  return `${JSON.stringify(header)}\n${JSON.stringify(item)}\n${JSON.stringify(event)}\n`;
}

/** A ready-to-send request; the transport only has to perform it. */
export interface MonitorTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Performs one request. Rejecting is fine: the caller logs and swallows the
 * failure, because error reporting must never break the application.
 */
export type MonitorTransport = (request: MonitorTransportRequest) => Promise<void>;

/** `fetch` signature, narrowed so a test double is trivial to write. */
export type FetchLike = typeof fetch;

/** Default transport: one `fetch` POST to the envelope endpoint. */
export function createFetchTransport(fetchImplementation: FetchLike = fetch): MonitorTransport {
  return async (request) => {
    const response = await fetchImplementation(request.url, {
      method: 'POST',
      headers: { ...request.headers },
      body: request.body,
    });

    if (!response.ok) {
      throw new Error(
        `[slate/observability] the error-monitoring endpoint responded with HTTP ${response.status}.`,
      );
    }
  };
}

/** Options accepted by {@link createErrorMonitor}. Everything is injectable. */
export interface ErrorMonitorOptions {
  /** Defaults to `SLATE_SERVICE`, then `slate-platform`. */
  readonly service?: string | undefined;
  /** Defaults to `SENTRY_DSN`; without a DSN, monitoring stays off. */
  readonly dsn?: string | undefined;
  /** Defaults to `SENTRY_ENVIRONMENT`, then `SLATE_ENV`. */
  readonly environment?: string | undefined;
  /** Defaults to `SENTRY_RELEASE`; omitted from events when unknown. */
  readonly release?: string | undefined;
  /** Forces the decision instead of deriving it from the environment. */
  readonly enabled?: boolean | undefined;
  /** Logger for this baseline's own diagnostics (never for payload content). */
  readonly logger?: Logger | undefined;
  /** Defaults to {@link createFetchTransport}. */
  readonly transport?: MonitorTransport | undefined;
  readonly now?: (() => Date) | undefined;
  readonly redact?: RedactOptions | undefined;
  /** Defaults to {@link DEFAULT_MAX_PENDING_EVENTS}. */
  readonly maxPending?: number | undefined;
  /** Environment map; defaults to `process.env`. */
  readonly env?: EnvironmentVariables | undefined;
}

export interface CaptureMessageOptions {
  readonly level?: SentryEventLevel | undefined;
  readonly context?: LogContext | undefined;
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

/**
 * The error monitor.
 *
 * No method throws: an application that cannot reach the collector still has to
 * serve requests, so a transport failure is logged and swallowed.
 */
export interface ErrorMonitor {
  /** `false` when no DSN is configured or monitoring was switched off. */
  readonly enabled: boolean;
  readonly environment: string;
  readonly release: string | undefined;
  /**
   * Reports an error and returns the event id, which is what correlates the
   * report in the collector with the log line written next to it.
   */
  captureException(error: unknown, context?: LogContext): string;
  /** Reports a message: a health signal, or a recovered anomaly. */
  captureMessage(message: string, options?: CaptureMessageOptions): string;
  /** Waits for in-flight events; `false` when the timeout elapsed first. */
  flush(timeoutMs?: number): Promise<boolean>;
}

/**
 * Creates the error monitor.
 *
 * Monitoring stays off when no DSN is configured (`SENTRY_DSN` blank) or when
 * `SLATE_DISABLE_ERROR_MONITORING` is set - the break-glass flag wins, so an
 * operator can stop the flow during an incident without touching secrets. A
 * disabled monitor still returns event ids, so call sites never branch on
 * {@link ErrorMonitor.enabled}.
 *
 * @example
 * ```ts
 * const monitor = createErrorMonitor({ logger });
 * const eventId = monitor.captureException(error, { orderId });
 * logger.error('order capture failed', { err: error, eventId });
 * await monitor.flush();   // during shutdown
 * ```
 */
export function createErrorMonitor(options: ErrorMonitorOptions = {}): ErrorMonitor {
  const env = options.env ?? process.env;
  const service = options.service ?? serviceName(env);
  const environment = options.environment ?? sentryEnvironment(env);
  const release = options.release ?? sentryRelease(env);
  const dsn = options.dsn ?? sentryDsn(env);
  const logger = options.logger;
  const redact = options.redact ?? {};
  const now = options.now ?? ((): Date => new Date());
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_EVENTS;

  const explicitlyDisabled =
    options.enabled === false || (options.enabled === undefined && errorMonitoringDisabled(env));

  if (explicitlyDisabled) {
    logger?.debug('error monitoring is disabled by configuration', {
      variable: ERROR_MONITORING_DISABLED_VARIABLE,
      environment,
    });
  } else if (dsn === undefined) {
    logger?.warn('error monitoring is disabled: no error-monitoring DSN is configured', {
      variable: SENTRY_DSN_VARIABLE,
      environment,
    });
  }

  if (dsn === undefined || explicitlyDisabled) {
    return {
      enabled: false,
      environment,
      release,
      captureException: () => createEventId(),
      captureMessage: () => createEventId(),
      flush: () => Promise.resolve(true),
    };
  }

  const target = parseSentryDsn(dsn);
  const transport = options.transport ?? createFetchTransport();
  const pending = new Map<string, Promise<void>>();
  let droppedEvents = 0;

  function send(event: SentryEvent): string {
    if (pending.size >= maxPending) {
      droppedEvents += 1;
      logger?.warn('error monitoring is saturated: dropping an event', {
        eventId: event.event_id,
        maxPending,
        droppedEvents,
      });
      return event.event_id;
    }

    const request: MonitorTransportRequest = {
      url: target.envelopeUrl,
      headers: {
        'content-type': SENTRY_ENVELOPE_CONTENT_TYPE,
        'x-sentry-auth': target.authHeader,
      },
      body: buildSentryEnvelope(event, target.dsn, now()),
    };

    // Started behind a microtask: the call site is never blocked, and a thrown
    // error can never escape into the application - a monitor must never break
    // the code it observes.
    const inFlight = Promise.resolve()
      .then(() => transport(request))
      .catch((error: unknown) => {
        logger?.warn('error monitoring transport failed', { eventId: event.event_id, err: error });
      })
      .finally(() => {
        pending.delete(event.event_id);
      });

    pending.set(event.event_id, inFlight);
    return event.event_id;
  }

  function baseFields(): {
    event_id: string;
    timestamp: string;
    platform: 'node';
    sdk: { name: string; version: string };
    logger: string;
    environment: string;
    release?: string;
  } {
    return {
      event_id: createEventId(),
      timestamp: now().toISOString(),
      platform: 'node',
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      logger: service,
      environment,
      ...(release === undefined ? {} : { release }),
    };
  }

  /** Context is redacted through the same two layers the logger uses. */
  function redactedExtra(context: LogContext | undefined): Record<string, unknown> | undefined {
    if (context === undefined) {
      return undefined;
    }
    return redactValue(context, redact) as Record<string, unknown>;
  }

  return {
    enabled: true,
    environment,
    release,

    captureException(error, context) {
      const serialized = serializeError(error);
      const frames =
        serialized.stack === undefined ? [] : parseStackFrames(scrubSecrets(serialized.stack));
      const extra = redactedExtra(context);

      return send({
        ...baseFields(),
        level: 'error',
        exception: {
          values: [
            {
              type: serialized.name,
              value: scrubSecrets(serialized.message),
              ...(frames.length === 0 ? {} : { stacktrace: { frames } }),
            },
          ],
        },
        ...(extra === undefined ? {} : { extra }),
      });
    },

    captureMessage(message, captureOptions = {}) {
      const extra = redactedExtra(captureOptions.context);

      return send({
        ...baseFields(),
        level: captureOptions.level ?? 'info',
        message: scrubSecrets(message),
        ...(captureOptions.tags === undefined ? {} : { tags: captureOptions.tags }),
        ...(extra === undefined ? {} : { extra }),
      });
    },

    async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS) {
      if (pending.size === 0) {
        return true;
      }

      const settled = Promise.allSettled([...pending.values()]).then(() => true);

      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);

        void settled.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
  };
}
