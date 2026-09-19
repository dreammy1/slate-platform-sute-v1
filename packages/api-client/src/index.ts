/**
 * `@slate/api-client` — the **browser** entry point (SLATE-300, ADR 008 §5).
 *
 * Everything exported here is safe to bundle for the browser: the fetch-based
 * client, the typed result union, the versioned route builders and the input
 * guards. The server half lives behind `@slate/api-client/server`, which is
 * guarded at import and is never imported by a client component (enforced by the
 * `slate/no-server-import-in-client` ESLint rule).
 *
 * The client holds no authority. It cannot state a tenant, cannot read the session
 * cookie and cannot decide what a user may do; the server does all three.
 */

export {
  createApiClient,
  REQUEST_ID_HEADER,
  type ApiClient,
  type ApiClientOptions,
  type ApiMethod,
  type ApiRequestInput,
} from './client.ts';
export {
  errorMessageFor,
  isApiFailure,
  kindForStatus,
  type ApiErrorKind,
  type ApiFailure,
  type ApiResult,
  type ApiSuccess,
} from './errors.ts';
export {
  API_PREFIX,
  ApiClientUsageError,
  apiPath,
  assertNoTenantInput,
  buildQuery,
  routes,
  stripApiPrefix,
  TENANT_INPUT_NAMES,
} from './routes.ts';
