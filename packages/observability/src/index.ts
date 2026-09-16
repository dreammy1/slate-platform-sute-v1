/**
 * `@slate/observability` - the logging and error-monitoring baseline.
 *
 * Three things are exported, in the order an application needs them:
 *
 * 1. **Configuration readers** ({@link slateEnvironment}, {@link resolveLogLevel},
 *    {@link resolveLogFormat}, ...) - pure, injectable, and strict about typos.
 * 2. **A logger** ({@link createLogger}) whose records are structured, bounded
 *    and redacted on the way to the sink.
 * 3. **An error monitor** ({@link createErrorMonitor}) that reports failures
 *    through a vendor-free Sentry envelope.
 *
 * Every module is also importable on its own (`@slate/observability/logger`,
 * `@slate/observability/monitor`) so a consumer that only needs redaction or
 * envelope building does not pull in the rest.
 *
 * Master Plan reference: Section 61 (logging and monitoring rules).
 */

export * from './env.ts';
export * from './errors.ts';
export * from './logger.ts';
export * from './monitor.ts';
export * from './redact.ts';
