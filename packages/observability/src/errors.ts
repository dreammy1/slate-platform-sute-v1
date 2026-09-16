/**
 * Error serialization shared by the logger and the error monitor.
 *
 * JavaScript errors do not survive `JSON.stringify` (message, stack and cause
 * are not enumerable), so an error logged without this helper arrives as `{}`.
 * Serializing explicitly is also what makes errors reviewable: name, message,
 * stack and the full `cause` chain are preserved.
 */

/** An error reduced to a JSON-safe, structured shape. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: SerializedError;
}

/**
 * How deep a `cause` chain is followed before it is cut off. Deep chains are
 * usually a retry loop re-wrapping the same failure, and a log record must stay
 * bounded.
 */
export const MAX_ERROR_CAUSE_DEPTH = 5;

function describeNonError(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return `[function ${value.name === '' ? 'anonymous' : value.name}]`;
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? Object.prototype.toString.call(value) : json;
  } catch {
    return '[unserializable object]';
  }
}

/**
 * Converts anything that can be thrown into a structured, JSON-safe error.
 *
 * A non-`Error` value (a bare string, a rejected promise payload, a thrown
 * object) is preserved under the name `NonError`, because losing the thrown
 * value is exactly the information a review needs.
 */
export function serializeError(error: unknown, depth = 0): SerializedError {
  if (error instanceof Error) {
    const serialized: {
      name: string;
      message: string;
      stack?: string;
      cause?: SerializedError;
    } = {
      name: error.name === '' ? 'Error' : error.name,
      message: error.message,
    };

    if (typeof error.stack === 'string' && error.stack !== '') {
      serialized.stack = error.stack;
    }
    if (error.cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) {
      serialized.cause = serializeError(error.cause, depth + 1);
    }

    return serialized;
  }

  return { name: 'NonError', message: describeNonError(error) };
}
