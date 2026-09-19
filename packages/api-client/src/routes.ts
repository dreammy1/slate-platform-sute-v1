/**
 * Routes and the versioned prefix (SLATE-300, ADR 008 §5, Master Plan Section 58).
 *
 * Section 58 requires external APIs to be versioned. The platform pipeline itself
 * serves unversioned paths today, so the prefix is applied at the application
 * boundary — by the client on the way out and by the route handler on the way in —
 * and this module is the only place that knows the string. Reconciling the
 * contract file with the prefix is part of SLATE-300's Definition of Done.
 */

/** The versioned mount point of the platform API. */
export const API_PREFIX = '/api/v1';

/** Raised for a client programmer error, never for an HTTP failure. */
export class ApiClientUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiClientUsageError';
  }
}

/** Input names that would let a browser state its own tenant. */
export const TENANT_INPUT_NAMES = [
  'tenantId',
  'tenant_id',
  'tenantid',
  'x-tenant-id',
  'organizationId',
  'organization_id',
] as const;

/**
 * Joins a caller's path onto the versioned prefix.
 *
 * Rejects an absolute URL and a path that already carries the prefix, so a caller
 * cannot escape the versioning or double it.
 */
export function apiPath(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new ApiClientUsageError(
      `"${path}" is an absolute URL. The client owns the origin: pass a path such as "/users".`,
    );
  }
  const normalised = path.startsWith('/') ? path : `/${path}`;
  if (normalised.startsWith(`${API_PREFIX}/`) || normalised === API_PREFIX) {
    throw new ApiClientUsageError(
      `"${path}" already includes "${API_PREFIX}"; the client adds it (ADR 008 §5).`,
    );
  }
  return `${API_PREFIX}${normalised}`;
}

/**
 * Removes the versioned prefix from an incoming request path.
 *
 * Returns `undefined` when the path is outside the prefix, which the route handler
 * answers as a 404 rather than forwarding onto the platform API.
 */
export function stripApiPrefix(path: string): string | undefined {
  if (path === API_PREFIX) return '/';
  if (!path.startsWith(`${API_PREFIX}/`)) return undefined;
  return path.slice(API_PREFIX.length);
}

/**
 * Refuses a query or body that tries to carry a tenant.
 *
 * The tenant always comes from the session and is resolved server-side (Master
 * Plan Section 13). Making this a hard, synchronous failure means a developer
 * cannot add one "temporarily" and have it silently ignored by the server.
 */
export function assertNoTenantInput(input: unknown, where: string): void {
  if (typeof input !== 'object' || input === null) return;
  const keys = Object.keys(input as Record<string, unknown>);
  const offending = keys.filter((key) =>
    (TENANT_INPUT_NAMES as readonly string[]).includes(key.toLowerCase()),
  );
  if (offending.length > 0) {
    throw new ApiClientUsageError(
      `${where} carries ${offending.join(', ')}. The tenant is resolved from the session ` +
        'server-side and is never supplied by the browser (Master Plan Section 13).',
    );
  }
}

/** Serialises query parameters, dropping `undefined` and sorting for stability. */
export function buildQuery(query: Readonly<Record<string, string | number | undefined>>): string {
  assertNoTenantInput(query, 'the query');
  const entries = Object.entries(query)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(
    // `as const` makes each entry a `[string, string]` tuple, which the
    // `URLSearchParams` constructor accepts as a readonly pair list.
    entries.map(([key, value]) => [key, String(value)] as [string, string]),
  ).toString()}`;
}

/**
 * The platform endpoints the shell uses, so paths are spelled once.
 * Adding a route here is how a screen gets a typed path.
 */
export const routes = {
  users: '/users',
  settings: '/settings',
  setting: (key: string) => `/settings/${encodeURIComponent(key)}`,
  featureFlags: '/features',
  featureFlag: (key: string) => `/features/${encodeURIComponent(key)}`,
  jobs: '/jobs',
  job: (jobId: string) => `/jobs/${jobId}`,
  media: '/media',
  mediaPresign: '/media/presign',
  mediaFile: (id: string) => `/media/${id}`,
  search: (entity: string) => `/search/${encodeURIComponent(entity)}`,
  healthLive: '/health/live',
  healthReady: '/health/ready',
} as const;
