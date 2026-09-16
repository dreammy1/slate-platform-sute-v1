import { serializeError } from './errors.ts';

/**
 * Redaction is the reason this module exists: "no sensitive customer data in
 * the logs" (Master Plan, Section 61) has to be a property of the logging
 * baseline itself, not of every individual call site. A developer who forgets
 * to scrub a token still cannot leak it, because the record is redacted on the
 * way to the sink.
 *
 * Two layers are applied:
 *
 * 1. **Key based** - a value stored under a key that looks sensitive
 *    (`password`, `authorization`, `apiKey`, `access_token`, ...) is replaced.
 * 2. **Content based** - a string that *contains* credentials (a connection
 *    string with a password, a `Bearer` header) is scrubbed in place, wherever
 *    it appears: in a message, a nested value or an error message.
 */

/** Replacement written in place of a redacted value. */
export const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * Key fragments that mark a value as sensitive. A key is redacted when its
 * normalized form (lowercase, separators removed) *contains* one of them, so
 * `apiKey`, `api_key`, `X-API-KEY` and `xApiKey` are all covered by `apikey`.
 *
 * The list is deliberately aggressive - a false positive costs one unreadable
 * field in a log line, a false negative leaks a credential into a log store.
 * Short fragments are excluded on purpose: `pin` would match `shipping`, and a
 * bare `key` would match `monkey`, both of which are legitimate fields.
 */
export const DEFAULT_SENSITIVE_KEY_TOKENS = [
  'authorization',
  'apikey',
  'accesskey',
  'bearer',
  'cardnumber',
  'cookie',
  'credential',
  'cvc',
  'cvv',
  'licensekey',
  'password',
  'passwd',
  'privatekey',
  'pwd',
  'secret',
  'session',
  'signature',
  'token',
] as const;

/** Credentials inside a URL: `scheme://user:password@host` -> `scheme://user:[redacted]@host`. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s/@]*@/gi;

/** Values of an `Authorization`-style header, e.g. `Bearer eyJhbGciOi...`. */
const BEARER_SECRET = /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi;

/** Depth at which a nested value is replaced; keeps records bounded. */
export const DEFAULT_MAX_DEPTH = 6;

/** Number of array/collection entries kept before truncation. */
export const DEFAULT_MAX_ARRAY_LENGTH = 50;

/** Marker written when the depth limit was reached. */
export const MAX_DEPTH_MARKER = '[max-depth]';

/** Marker written for a repeated reference (a cycle). */
export const CIRCULAR_MARKER = '[circular]';

export interface RedactOptions {
  /** Overrides {@link DEFAULT_SENSITIVE_KEY_TOKENS}. */
  readonly tokens?: readonly string[] | undefined;
  /** Overrides {@link REDACTED_PLACEHOLDER}. */
  readonly placeholder?: string | undefined;
  /** Overrides {@link DEFAULT_MAX_DEPTH}. */
  readonly maxDepth?: number | undefined;
  /** Overrides {@link DEFAULT_MAX_ARRAY_LENGTH}. */
  readonly maxArrayLength?: number | undefined;
  /**
   * When `false`, strings are left untouched apart from key-based redaction.
   * Only useful when a test wants to prove the key layer on its own.
   */
  readonly scrubStrings?: boolean | undefined;
}

/**
 * Removes credentials that are embedded in a string. Applied to every string
 * that enters a log record - including messages and serialized error text,
 * where a connection string or an `Authorization` header is most likely to end
 * up by accident.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(URL_CREDENTIALS, `$1:${REDACTED_PLACEHOLDER}@`)
    .replace(BEARER_SECRET, `$1${REDACTED_PLACEHOLDER}`);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `true` when a value stored under `key` must be replaced before serialization. */
export function isSensitiveKey(
  key: string,
  tokens: readonly string[] = DEFAULT_SENSITIVE_KEY_TOKENS,
): boolean {
  const normalized = normalizeKey(key);
  if (normalized === '') {
    return false;
  }
  return tokens.some((token) => {
    const candidate = normalizeKey(token);
    return candidate !== '' && normalized.includes(candidate);
  });
}

/** Internal, resolved redaction state; created once per {@link redactValue} call. */
interface RedactState {
  readonly tokens: readonly string[];
  readonly placeholder: string;
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly scrubStrings: boolean;
  /** Objects on the current path; used to detect real cycles only. */
  readonly path: WeakSet<object>;
}

function redactArray(value: readonly unknown[], state: RedactState, depth: number): unknown[] {
  const limit = Math.min(value.length, state.maxArrayLength);
  const result: unknown[] = [];
  for (let index = 0; index < limit; index += 1) {
    result.push(redactInternal(value[index], state, depth + 1));
  }
  if (value.length > limit) {
    result.push(`[${value.length - limit} more items]`);
  }
  return result;
}

function redactMap(
  value: ReadonlyMap<unknown, unknown>,
  state: RedactState,
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let emitted = 0;
  for (const [key, entry] of value) {
    if (emitted >= state.maxArrayLength) {
      result['[truncated]'] = `${value.size - emitted} more entries`;
      break;
    }
    const name = typeof key === 'string' ? key : String(key);
    result[name] = isSensitiveKey(name, state.tokens)
      ? state.placeholder
      : redactInternal(entry, state, depth + 1);
    emitted += 1;
  }
  return result;
}

function redactInternal(value: unknown, state: RedactState, depth: number): unknown {
  switch (typeof value) {
    case 'string':
      return state.scrubStrings ? scrubSecrets(value) : value;
    case 'number':
    case 'boolean':
      return value;
    case 'undefined':
      return undefined;
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return `[function ${value.name === '' ? 'anonymous' : value.name}]`;
    default:
      break;
  }

  // Past the switch `typeof value` is always `object`: every other case
  // returned. TypeScript cannot prove that on an `unknown` in a `switch`, so the
  // non-object case is stated once more and the narrowing becomes explicit.
  if (typeof value !== 'object') {
    return value;
  }

  if (value === null) {
    return null;
  }
  if (depth >= state.maxDepth) {
    return MAX_DEPTH_MARKER;
  }
  if (state.path.has(value)) {
    return CIRCULAR_MARKER;
  }

  // Binary payloads (a request body, a file buffer) are summarized: shipping
  // their bytes into a log store is both useless and a disclosure risk.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return redactInternal(serializeError(value), state, depth + 1);
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (value instanceof URL) {
    return redactInternal(value.toString(), state, depth + 1);
  }

  state.path.add(value);
  try {
    if (Array.isArray(value)) {
      return redactArray(value, state, depth);
    }
    if (value instanceof Map) {
      return redactMap(value, state, depth);
    }
    if (value instanceof Set) {
      return redactArray([...value], state, depth);
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = isSensitiveKey(key, state.tokens)
        ? state.placeholder
        : redactInternal(entry, state, depth + 1);
    }
    return result;
  } finally {
    // Path-based, so the same object referenced twice is still expanded twice
    // and only genuine cycles are cut.
    state.path.delete(value);
  }
}

/**
 * Produces a JSON-safe, redacted copy of a value.
 *
 * Errors become structured objects ({@link serializeError}), dates become ISO
 * strings, `Map`/`Set` become plain JSON, binary data is summarized, and the
 * result is bounded by depth and collection limits. The input is never mutated.
 */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  return redactInternal(
    value,
    {
      tokens: options.tokens ?? DEFAULT_SENSITIVE_KEY_TOKENS,
      placeholder: options.placeholder ?? REDACTED_PLACEHOLDER,
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxArrayLength: options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
      scrubStrings: options.scrubStrings ?? true,
      path: new WeakSet<object>(),
    },
    0,
  );
}
