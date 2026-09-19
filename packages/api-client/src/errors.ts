/**
 * Typed API results (SLATE-300, ADR 008 §5).
 *
 * A screen decides what to render from a discriminated union, never by parsing an
 * error message. That matters most for 403 versus 404: the platform deliberately
 * makes a foreign row indistinguishable from a missing one, and a frontend that
 * collapsed the two would either leak existence or hide a permission problem.
 */

/** Every way a request can fail, named after the HTTP status it came from. */
export type ApiErrorKind =
  | 'transport'
  | 'bad_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'unsupported_media_type'
  | 'unexpected'
  | 'server';

export interface ApiSuccess<TData> {
  readonly ok: true;
  readonly status: number;
  readonly data: TData;
  /** Echoed from `x-request-id`, for correlating with the server's audit row. */
  readonly requestId: string | undefined;
}

export interface ApiFailure {
  readonly ok: false;
  readonly status: number;
  readonly kind: ApiErrorKind;
  /** Safe to display: the API's error shape carries no internal detail. */
  readonly message: string;
  readonly requestId: string | undefined;
}

/** What every client call resolves to. It never rejects for an HTTP failure. */
export type ApiResult<TData> = ApiSuccess<TData> | ApiFailure;

/** The `{ error }` shape the platform API returns for every non-2xx answer. */
interface ApiErrorBody {
  readonly error?: unknown;
}

/** Maps a status onto the union member a caller can branch on. */
export function kindForStatus(status: number): ApiErrorKind {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'too_large';
    case 415:
      return 'unsupported_media_type';
    default:
      if (status >= 500) return 'server';
      // A transport failure has no status; anything else unmapped is still a
      // client error the caller must not treat as success.
      return status === 0 ? 'transport' : 'unexpected';
  }
}

export function isApiFailure<TData>(result: ApiResult<TData>): result is ApiFailure {
  return !result.ok;
}

/**
 * Turns a non-2xx response body into a message, preferring the API's own error
 * string and falling back to the status text so a caller always has something
 * contextless-but-truthful to show.
 */
export function errorMessageFor(status: number, body: unknown, statusText: string): string {
  if (typeof body === 'object' && body !== null) {
    const candidate = (body as ApiErrorBody).error;
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return statusText.trim() === '' ? `Request failed with status ${status}` : statusText;
}
