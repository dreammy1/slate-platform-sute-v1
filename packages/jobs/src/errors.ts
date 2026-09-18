/**
 * Typed failures for the job queue.
 *
 * Every error carries a stable machine `code` from the migration's allowlist
 * (`handler_error`, `payload_invalid`, `unknown_type`, `handler_timeout`,
 * `lease_lost`), so the `last_error_code` column and log lines never contain
 * arbitrary exception text (Section 61: no sensitive data in logs).
 */

/** The allowlisted failure codes persisted in `background_job.last_error_code`. */
export const JOB_ERROR_CODES = [
  'handler_error',
  'payload_invalid',
  'unknown_type',
  'handler_timeout',
  'lease_lost',
] as const;

/** One of the allowlisted job failure codes. */
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

/** Base class: a typed, code-carrying queue failure. */
export class JobError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

/** The registry does not know the requested job type, or a definition is invalid. */
export class JobRegistryError extends JobError {
  constructor(message: string) {
    super('unknown_type', message);
    this.name = 'JobRegistryError';
  }
}

/**
 * A payload failed validation on write (enqueue) or on read (worker). Handlers
 * never run for an unparseable payload: the job is failed terminally instead.
 */
export class JobPayloadError extends JobError {
  constructor(message: string) {
    super('payload_invalid', message);
    this.name = 'JobPayloadError';
  }
}

/** An idempotency key was reused with a different payload. */
export class JobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobConflictError';
  }
}

/**
 * A handler-declared permanent failure. A job that throws this is moved to
 * `failed` immediately instead of being retried — the handler has decided the
 * work cannot succeed for this input (for example a missing referenced row).
 * The `code` defaults to `handler_error` and must be allowlisted.
 */
export class NonRetryableJobError extends JobError {
  constructor(code: JobErrorCode = 'handler_error', message = 'non-retryable job failure') {
    super(JOB_ERROR_CODES.includes(code) ? code : 'handler_error', message);
    this.name = 'NonRetryableJobError';
  }
}
