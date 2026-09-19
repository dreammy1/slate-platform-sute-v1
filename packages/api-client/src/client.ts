/**
 * The browser API client (SLATE-300, ADR 008 §5).
 *
 * This is the only module the browser uses to reach the platform, and it holds no
 * authority: it cannot choose a tenant, it cannot read the session, and it does not
 * decide what a user may do. It prefixes the versioned mount point, propagates a
 * request id for correlation with the server's audit row, sends the session cookie
 * without being able to read it, and turns every response into a typed result.
 */

import { errorMessageFor, kindForStatus, type ApiResult } from './errors.ts';
import { apiPath, assertNoTenantInput, buildQuery, ApiClientUsageError } from './routes.ts';

/** Correlates a browser action with the API's log line and audit row (Section 61). */
export const REQUEST_ID_HEADER = 'x-request-id';

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiClientOptions {
  /**
   * Origin to call. Empty means same-origin, which is the browser default and the
   * only value that keeps the session cookie first-party.
   */
  readonly baseUrl?: string;
  /** Injected for tests and for the server-side HTTP caller. */
  readonly fetch?: typeof globalThis.fetch;
  /** Extra headers per request. Never a tenant: the tenant is server-resolved. */
  readonly headers?: () => Readonly<Record<string, string>>;
  /** Injected id source, so tests assert the header deterministically. */
  readonly newRequestId?: () => string;
}

export interface ApiRequestInput {
  readonly method: ApiMethod;
  /** A path relative to the versioned prefix, e.g. `routes.settings`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  /** Reuse an existing id (for example one already logged) instead of a new one. */
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  request<TData>(input: ApiRequestInput): Promise<ApiResult<TData>>;
  get<TData>(
    path: string,
    query?: Readonly<Record<string, string | number | undefined>>,
  ): Promise<ApiResult<TData>>;
  post<TData>(path: string, body?: unknown): Promise<ApiResult<TData>>;
  put<TData>(path: string, body?: unknown): Promise<ApiResult<TData>>;
  delete<TData>(path: string): Promise<ApiResult<TData>>;
}

/** A request id, with a fallback for environments without `crypto.randomUUID`. */
function defaultRequestId(): string {
  const source: Crypto | undefined = globalThis.crypto;
  if (source !== undefined && typeof source.randomUUID === 'function') {
    return source.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Parses a body that may legitimately be empty (204, or a plain-text error). */
function parseBody(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Creates a client bound to one origin.
 *
 * Every method resolves rather than rejects for an HTTP failure: a 403 is a result
 * the UI renders, not an exception it might swallow. Only a programmer error (an
 * absolute URL, a double prefix, or a tenant in the input) throws.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '';
  // Bound deliberately: an unbound `fetch` throws "Illegal invocation" in browsers.
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<TData>(input: ApiRequestInput): Promise<ApiResult<TData>> {
    const target = apiPath(input.path);
    const query = buildQuery(input.query ?? {});
    if (input.body !== undefined) assertNoTenantInput(input.body, 'the request body');

    const requestId = input.requestId ?? (options.newRequestId ?? defaultRequestId)();
    const headers: Record<string, string> = {
      accept: 'application/json',
      [REQUEST_ID_HEADER]: requestId,
      ...(options.headers?.() ?? {}),
    };
    if (input.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${target}${query}`, {
        method: input.method,
        headers,
        // The session is an httpOnly cookie: sent automatically, never readable here.
        credentials: 'same-origin',
        // Tenant data is per-request; a shared cache must never key it (ADR 008 §2).
        cache: 'no-store',
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch {
      // The transport error is not surfaced: it can carry a URL, and the UI cannot
      // act on it. The request id still ties the attempt to the server's logs.
      return {
        ok: false,
        status: 0,
        kind: 'transport',
        message: 'The request could not be sent.',
        requestId,
      };
    }

    const text = await response.text();
    const data = parseBody(text);
    const responseRequestId = response.headers.get(REQUEST_ID_HEADER) ?? requestId;

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        data: data as TData,
        requestId: responseRequestId,
      };
    }

    return {
      ok: false,
      status: response.status,
      kind: kindForStatus(response.status),
      message: errorMessageFor(response.status, data, response.statusText),
      requestId: responseRequestId,
    };
  }

  return {
    request,
    get: (path, query) =>
      request({ method: 'GET', path, ...(query === undefined ? {} : { query }) }),
    post: (path, body) =>
      request({ method: 'POST', path, ...(body === undefined ? {} : { body }) }),
    put: (path, body) => request({ method: 'PUT', path, ...(body === undefined ? {} : { body }) }),
    delete: (path) => request({ method: 'DELETE', path }),
  };
}

export { ApiClientUsageError };
