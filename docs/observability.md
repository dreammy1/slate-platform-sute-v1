# Observability

`@slate/observability` is the logging and error-monitoring baseline of the
platform: structured, bounded, redacted log records, and error reports that
speak the _public Sentry envelope protocol_ over plain `fetch`. It has **no
runtime dependencies**, no vendor SDK, no auto-instrumentation and no global
patching - the payload is inspectable byte for byte and the transport is
injectable, so tests never touch the network.

Master Plan reference: Section 61 (structured logging, no sensitive data in
logs, correlation of errors with releases).

## Package map

| Entry point                    | Contents                                                         |
| ------------------------------ | ---------------------------------------------------------------- |
| `@slate/observability`         | Everything below, re-exported.                                   |
| `@slate/observability/env`     | The environment contract and its readers.                        |
| `@slate/observability/logger`  | `createLogger`, record shaping, formatting, sinks.               |
| `@slate/observability/redact`  | The two redaction layers (`redactValue`, `scrubSecrets`).        |
| `@slate/observability/errors`  | `serializeError` (bounded error to plain object).                |
| `@slate/observability/monitor` | `createErrorMonitor`, DSN parsing, envelope building, transport. |

Every module is importable on its own, so a consumer that needs only
redaction does not pull in the monitor.

## Environment contract

Configuration is read through pure helpers that take the environment map as
an argument (`process.env` by default). A wrong value **throws with the
variable name in the message** at startup - it never silently falls back.

| Variable                         | Meaning                                                                    | Default                                                            |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `SLATE_ENV`                      | Authoritative environment name (`NODE_ENV` is the fallback).               | `development`                                                      |
| `SLATE_SERVICE`                  | Service identity on every record and report.                               | `slate-platform`                                                   |
| `LOG_LEVEL`                      | Minimum level: `debug` \| `info` \| `warn` \| `error`.                     | `debug` in `development`/`test`, otherwise `info`                  |
| `LOG_FORMAT`                     | `json` (machines) or `pretty` (developer terminal).                        | `json`; `pretty` only on an interactive TTY in a local environment |
| `SENTRY_DSN`                     | Error-monitoring DSN; blank or absent disables monitoring.                 | _(unset)_                                                          |
| `SENTRY_ENVIRONMENT`             | Environment tag on error reports.                                          | the `SLATE_ENV` value                                              |
| `SENTRY_RELEASE`                 | Release id (tag or commit SHA).                                            | _(unset - field omitted)_                                          |
| `SLATE_DISABLE_ERROR_MONITORING` | Break-glass switch; only `1/true/yes/on` or `0/false/no/off` are accepted. | monitoring on (if a DSN exists)                                    |

Per-environment values live in the environment templates (`.env.example`,
`.env.staging.example`, `.env.preview.example`) and are explained in
`docs/environments.md`.

## Logging

A record is flat, JSON-serializable, and has the same leading fields
everywhere - that is what makes logs queryable without per-app parsing rules:

```json
{
  "level": "info",
  "time": "2026-01-01T00:00:00.000Z",
  "msg": "order confirmed",
  "service": "slate-staging",
  "environment": "staging",
  "release": "v1.2.3",
  "orderId": "ord_123"
}
```

- Levels: `debug < info < warn < error`; records below the configured level
  are dropped, and `logger.isEnabled(level)` mirrors the decision.
- Reserved fields (`level`, `time`, `msg`, `service`, `environment`,
  `release` - exported as `RESERVED_LOG_FIELDS`) are owned by the logger;
  bindings or context keys with those names are dropped, so application data
  can never overwrite the level, the timestamp or the service identity.
- `logger.child({ requestId })` merges bindings (reserved fields ignored);
  children share level, format, sink and redaction with their parent.
- The default sink writes one line per record: `debug`/`info` to stdout,
  `warn`/`error` to stderr. Tests and embedding applications inject their
  own sink (`options.sink`); `options.now` makes time deterministic.
- Methods are properties, not `this`-bound methods, so a destructured
  `const { info } = logger` keeps working.

```ts
import { createLogger } from '@slate/observability';

const logger = createLogger({ bindings: { requestId } });
logger.info('order confirmed', { orderId });
logger.error('capture failed', { err, orderId });
```

## Redaction

Redaction runs inside the logger and the monitor - it is a safety net, not a
substitute for not logging secrets. Two layers:

1. **Key layer** (`redactValue`): values under sensitive keys are replaced
   with `[redacted]` (`REDACTED_PLACEHOLDER`). The default tokens cover
   password/secret/token/credential/api-key/authorization style names
   (`DEFAULT_SENSITIVE_KEY_TOKENS`); extend them with `options.tokens`, or
   replace them entirely with `options.tokensOnly`.
2. **Content layer** (`scrubSecrets`): pattern-based scrubbing of strings
   that carry secrets regardless of the key they sit under - connection
   strings, bearer tokens and similar. Log messages and exception stacks are
   scrubbed with the same function: a DSN pasted into an error message is
   the most common accidental leak.

Bounds and safety:

- `depth: 6` (`DEFAULT_MAX_DEPTH`) and `arrayLength: 50`
  (`DEFAULT_MAX_ARRAY_LENGTH`) keep hostile or huge structures bounded;
  cut-off points are marked with `[max-depth]`.
- Cycles become `[circular]` instead of a stack-blowing loop.
- The result is JSON-safe (Maps, Sets, Dates, `BigInt`, ... are converted);
  the input value is never mutated.
- A message stream that is already trusted can skip the content layer with
  `redact: { scrubStrings: false }` on the logger or monitor options.

## Error monitoring

`createErrorMonitor` reports failures without owning the process:

| Situation                               | Behaviour                                                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN` unset or blank             | Monitor disabled; a `warn` explains it once.                                                                                                          |
| `SLATE_DISABLE_ERROR_MONITORING` truthy | Monitor disabled; `debug` notes the break-glass switch.                                                                                               |
| DSN malformed                           | `parseSentryDsn` **throws at startup** - a typo must not read as "monitoring off".                                                                    |
| DSN valid                               | Events go to `<scheme>://<host>[<prefix>]/api/<project>/envelope/` with `content-type: application/x-sentry-envelope` and the `X-Sentry-Auth` header. |

- `monitor.captureException(error, context?)` serializes the error
  (`serializeError`, cause chain bounded by `MAX_ERROR_CAUSE_DEPTH = 5`),
  parses the V8 stack into Sentry frames (oldest first, capped at
  `MAX_STACK_FRAMES = 50`), scrubs message and stack, redacts the context
  and returns the event id.
- `monitor.captureMessage(message, { level, tags, context })` reports a
  message at `info` by default (`SentryEventLevel`: `debug`, `info`,
  `warning`, `error`, `fatal`).
- Sending is fire-and-forget: it starts behind a microtask, can never throw
  into the application, and a transport failure is logged through the
  injected logger (`warn`) instead of surfacing as an error.
- Saturation is bounded: at most `DEFAULT_MAX_PENDING_EVENTS = 20` events in
  flight; beyond that events are dropped and counted in a `warn`.
- `await monitor.flush(timeoutMs = 2_000)` during shutdown resolves `true`
  when everything in flight settled and `false` on timeout.

```ts
import { createErrorMonitor, createLogger } from '@slate/observability';

const logger = createLogger();
const monitor = createErrorMonitor({ logger });

try {
  await chargeOrder(orderId);
} catch (error) {
  const eventId = monitor.captureException(error, { orderId });
  logger.error('order capture failed', { err: error, orderId, eventId });
}

await monitor.flush(); // during shutdown
```

## Defaults per environment

|                      | local                          | CI                       | staging             | preview             |
| -------------------- | ------------------------------ | ------------------------ | ------------------- | ------------------- |
| `LOG_LEVEL`          | `debug`                        | `debug` (nothing is set) | `info`              | `debug`             |
| `LOG_FORMAT`         | `pretty` on a TTY, else `json` | `json`                   | `json`              | `json`              |
| `SENTRY_DSN`         | _(unset)_                      | _(unset)_                | staging project DSN | preview project DSN |
| `SENTRY_ENVIRONMENT` | `development`                  | `development`            | `staging`           | `preview`           |

## Testing

The package ships 5 unit test files / 80 tests (`env`, `errors`, `redact`,
`logger`, `monitor`) covering configuration errors, record shape, reserved
fields, level filtering, both redaction layers, bounds and cycles, DSN
parsing, envelope bytes, stack parsing, disabled modes, capture and flush
timeouts, transport failures and saturation:

```bash
npm run test:unit --workspace @slate/observability
```

## Wiring checklist for applications (Phase 2+)

1. Create the logger and the monitor once at boot, from `process.env`.
2. Derive a child logger per request carrying the correlation ids
   (`requestId`).
3. Give the monitor the same logger; report with `captureException` and log
   with the returned `eventId`, so the log view and the error view correlate.
4. `await monitor.flush()` in the shutdown path.
5. Redaction is the last line of defence: never log secrets on purpose.
