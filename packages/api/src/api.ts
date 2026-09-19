/**
 * The tenant-aware request pipeline.
 *
 * Every route runs the same chain in the same order (Master Plan Section 13,
 * ADR 003):
 *
 * ```text
 * context -> authz -> db(tenantId) -> write + audit in ONE transaction -> events AFTER commit
 * ```
 *
 * The order *is* the security property. Tenant context is resolved before any
 * query is built, so an unauthenticated or unauthorized request never reaches
 * the database (the SLATE-203 test asserts `transaction` is not called).
 * Authorization happens before the work. A mutation and its mandatory
 * `audit_log` row commit in one transaction, so a failed audit rolls the write
 * back, and events are published only after that commit, so a rolled-back write
 * cannot announce itself.
 *
 * docs/adr/003-system-settings-and-feature-flags.md,
 * docs/phase2-agent-tasks.md (SLATE-203 and SLATE-204 API contracts).
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createAuth } from '@slate/auth';
import { createTenantDatabase, type Database } from '@slate/database';
import {
  resolveTenantContext,
  resolveTenantOrganization,
  type AuthenticatedPrincipal,
} from '@slate/tenant-context';
import {
  assertSettingKey,
  assertKnownFeatureFlag,
  FeatureFlagKeyError,
  SettingKeyError,
  SettingValueError,
  createTenantConfiguration,
  type FeatureFlagKey,
  type SettingValue,
} from '@slate/settings';
import { getJob, listJobs, JobPayloadError } from '@slate/jobs';
import { MediaEngine } from '@slate/media';
import {
  assertSearchEntity,
  MAX_SEARCH_LIMIT,
  postgresSearchEngine,
  SearchInputError,
  type SearchEngine,
} from '@slate/search';
import type { Logger } from '@slate/observability';
import type { EventBus } from './events.ts';

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  /** Injected by trusted session middleware, NEVER deserialized from the request body. */
  readonly principal: AuthenticatedPrincipal | undefined;
  readonly tenantId: string | undefined;
  /** Decoded query parameters; read routes validate them per contract. */
  readonly query?: Readonly<Record<string, string>> | undefined;
  readonly body?: unknown;
  /**
   * Carries the browser's `x-request-id` into the pipeline (Section 61,
   * SLATE-301). The value is correlation only: it is never logged as tenant
   * data, never trusted as an identifier, and echoes back on the response.
   */
  readonly requestId?: string | undefined;
}
export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  /**
   * Echoes the sanitized request id (Section 61, SLATE-301). The browser client
   * prefers this value over its own, so logs and audit rows join on one id.
   */
  readonly requestId?: string | undefined;
}

/** Longest request id accepted; longer values are dropped, never truncated. */
export const MAX_REQUEST_ID_LENGTH = 128;

/** Request-id characters the platform accepts; anything else is dropped. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * Sanitizes a caller-supplied request id.
 *
 * A request id is correlation only (never an identifier, never logged as data),
 * but it still crosses a trust boundary: an unbounded or control-character
 * value could pollute structured logs. Anything absent, non-string, empty,
 * over-long or off-alphabet is \"no id\" rather than a rejection.
 */
export function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_REQUEST_ID_LENGTH) return undefined;
  if (!REQUEST_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/** Attaches the sanitized id to a response, when one survived sanitizing. */
export function withRequestId(response: ApiResponse, requestId: string | undefined): ApiResponse {
  if (requestId === undefined) return response;
  return { ...response, requestId };
}

export interface ApiOptions {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly events: EventBus;
  /**
   * Injected, never defaulted. Storage is a deployment decision, and a hidden
   * local-disk fallback would write real tenant files into the process temp
   * directory the moment a host forgot to configure storage (ADR 006).
   */
  readonly mediaEngine: MediaEngine;
  /** Injected; defaults to the PostgreSQL engine of `@slate/search` (ADR 007). */
  readonly searchEngine?: SearchEngine;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super('Request rejected');
  }
}

/** The single JSON error shape every non-2xx answer uses (OpenAPI stub). */
function errorBody(status: number): { error: string } {
  return { error: status === 500 ? 'Internal server error' : 'Request rejected' };
}

function inputUser(body: unknown): { email: string; display_name: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400);
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !['email', 'name'].includes(key))) throw new HttpError(400);
  const { email, name } = fields;
  if (
    typeof email !== 'string' ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 200
  )
    throw new HttpError(400);
  return { email: email.toLowerCase(), display_name: name.trim() };
}

/**
 * Reads an optional positive-integer query parameter. Anything else is a 400:
 * `@slate/jobs` re-validates the bound, this catches malformed shapes first.
 */
function optionalInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new HttpError(400);
  return Number(raw);
}

/**
 * Reads the body of `PUT /settings/:key`.
 *
 * Only `value` is accepted: the tenant comes from the resolved context and the
 * value type is derived from the value itself, so neither can be supplied by a
 * client (Section 13). `undefined` is rejected rather than stored, because a
 * JSON body simply omits the field instead of sending it as null.
 */
function inputSettingValue(body: unknown): SettingValue {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400);
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== 'value')) throw new HttpError(400);
  if (!Object.hasOwn(fields, 'value')) throw new HttpError(400);
  return fields['value'] as SettingValue;
}

/**
 * Reads the body of `PUT /features/:key`.
 *
 * A boolean sets or overrides the flag and `null` clears the override so the
 * tenant falls back to the registry default. Nothing else is accepted: a
 * client never decides a flag's value beyond the tenant's own override, and
 * never supplies a tenant id.
 */
function inputFeatureFlagEnabled(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400);
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== 'enabled')) throw new HttpError(400);
  const { enabled } = fields;
  if (enabled === null) return null;
  if (typeof enabled !== 'boolean') throw new HttpError(400);
  return enabled;
}

/** How long a generated upload/download URL stays valid. */
const PRESIGN_EXPIRES_IN_SECONDS = 3600;
/**
 * A storage category is exactly one object-key segment, never a path: it is
 * joined into the key, so separators and dot segments are rejected outright.
 */
const STORAGE_SEGMENT = /^[a-z0-9_-]{1,64}$/;
/** The id `POST /media/presign` hands out and `POST /media` echoes back. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * The object key of a tenant-bound asset (`storage/{tenant}/{category}/{id}`).
 *
 * Every segment is validated before this is called, so the result can only ever
 * sit under the caller's own tenant prefix and no segment can carry `/`, `\` or
 * `..` out of it (ADR 006 tenant-bound access control).
 */
function mediaPath(tenantId: string, category: string, id: string): string {
  return `storage/${tenantId}/${category}/${id}`;
}

function readCategory(value: unknown): string {
  if (typeof value !== 'string' || !STORAGE_SEGMENT.test(value)) throw new HttpError(400);
  return value;
}

function readMediaId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400);
  return value;
}

function readMimeType(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[\w.+-]+\/[\w.+-]+$/.test(value))
    throw new HttpError(400);
  return value;
}

function readOriginalName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_FILE_NAME_LENGTH)
    throw new HttpError(400);
  return value;
}

/** Reads the body of `POST /media/presign`: no id, no path, no tenant id. */
function inputMediaPresign(body: unknown): {
  category: string;
  mimeType: string;
  originalName: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400);
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !['category', 'mimeType', 'originalName'].includes(key)))
    throw new HttpError(400);
  return {
    category: readCategory(fields['category']),
    mimeType: readMimeType(fields['mimeType']),
    originalName: readOriginalName(fields['originalName']),
  };
}

/**
 * Reads the body of `POST /media`, the completion half of the presigned flow.
 *
 * `id` is the value `POST /media/presign` returned. It is re-validated as a UUID
 * and the storage path is rebuilt from the tenant context, the category and that
 * UUID, so a client can neither choose where its bytes land nor walk out of its
 * own tenant prefix with a dot segment (Section 13).
 */
function inputMediaUpload(body: unknown): {
  id: string;
  category: string;
  mimeType: string;
  size: number;
  originalName: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400);
  const fields = body as Record<string, unknown>;
  if (
    Object.keys(fields).some(
      (key) => !['id', 'category', 'mimeType', 'size', 'originalName'].includes(key),
    )
  )
    throw new HttpError(400);
  const size = fields['size'];
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_UPLOAD_BYTES
  )
    throw new HttpError(400);
  return {
    id: readMediaId(fields['id']),
    category: readCategory(fields['category']),
    mimeType: readMimeType(fields['mimeType']),
    size,
    originalName: readOriginalName(fields['originalName']),
  };
}

/** The longest title and body a search document may carry (0009 CHECKs). */
const MAX_SEARCH_TITLE_LENGTH = 255;
const MAX_SEARCH_BODY_LENGTH = 20_000;

/**
 * Reads the body of `POST /search/:entity`.
 *
 * `recordId` is the id of the row the text describes, re-validated as a UUID so
 * it can never smuggle a path or a SQL fragment; the tenant comes from the
 * resolved context (Section 13).
 */
function inputSearchIndex(body: unknown): { recordId: string; title: string; body: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400);
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !['recordId', 'title', 'body'].includes(key)))
    throw new HttpError(400);
  const recordId = fields['recordId'];
  const title = fields['title'];
  const text = fields['body'];
  if (typeof recordId !== 'string' || !UUID.test(recordId)) throw new HttpError(400);
  if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_SEARCH_TITLE_LENGTH)
    throw new HttpError(400);
  if (typeof text !== 'string' || text.length > MAX_SEARCH_BODY_LENGTH) throw new HttpError(400);
  return { recordId, title, body: text };
}

/** Validates the `q`/`limit` pair of `GET /search/:entity` before any query. */
function inputSearchQuery(query: Readonly<Record<string, string>> | undefined): {
  q: string;
  limit: number | undefined;
} {
  const raw = query?.['q'] ?? '';
  if (raw.trim() === '' || raw.length > 200) throw new HttpError(400);
  const limit = optionalInteger(query?.['limit']);
  if (limit !== undefined && (limit < 1 || limit > MAX_SEARCH_LIMIT)) throw new HttpError(400);
  return { q: raw, limit };
}
/** The routes the scaffold serves, each with the permission key it requires. */
export const ROUTE_PERMISSIONS = {
  'GET /users': 'users.read',
  'POST /users': 'users.write',
  'GET /settings': 'settings.read',
  'PUT /settings/:key': 'settings.write',
  'GET /features': 'features.read',
  'PUT /features/:key': 'features.write',
  'GET /jobs': 'jobs.read',
  'GET /jobs/:id': 'jobs.read',
  'POST /media/presign': 'media.upload',
  'POST /media': 'media.upload',
  'GET /media/:id': 'media.read',
  'DELETE /media/:id': 'media.delete',
  'POST /search/:entity': 'search.write',
  'GET /search/:entity': 'search.read',
} as const;

export type RouteKey = keyof typeof ROUTE_PERMISSIONS;

/** A matched route, or the reason the request is not served. */
type RouteMatch =
  | { readonly ok: true; readonly route: RouteKey; readonly key: string | undefined }
  | { readonly ok: false; readonly status: 404 | 405 };

/**
 * Matches a request against the route table.
 *
 * A known path with an unknown method answers 405, so a client learns the path
 * exists but the verb is wrong; anything else is 404. `:key` is URL-decoded here
 * and validated downstream by `@slate/settings`, so a malformed key is a 400
 * rather than a routing surprise.
 *
 * The `:tenantSlug` route variant in the OpenAPI stub is deliberately not served
 * yet: resolving a slug to a tenant needs a lookup that ADR 003 does not
 * authorize, so only the id-based routes exist.
 */
export function matchRoute(request: ApiRequest): RouteMatch {
  const method = request.method.toUpperCase();
  const path = request.path.length > 1 ? request.path.replace(/\/+$/, '') : request.path;

  if (path === '/users') {
    if (method === 'GET') return { ok: true, route: 'GET /users', key: undefined };
    if (method === 'POST') return { ok: true, route: 'POST /users', key: undefined };
    return { ok: false, status: 405 };
  }

  if (path === '/settings') {
    if (method === 'GET') return { ok: true, route: 'GET /settings', key: undefined };
    return { ok: false, status: 405 };
  }

  if (path === '/features') {
    if (method === 'GET') return { ok: true, route: 'GET /features', key: undefined };
    return { ok: false, status: 405 };
  }

  if (path === '/jobs') {
    if (method === 'GET') return { ok: true, route: 'GET /jobs', key: undefined };
    return { ok: false, status: 405 };
  }

  const job = /^\/jobs\/(.+)$/.exec(path);
  if (job !== null) {
    if (method !== 'GET') return { ok: false, status: 405 };
    return { ok: true, route: 'GET /jobs/:id', key: job[1] };
  }

  // Media is a presigned flow plus a completion call, so the collection path
  // takes a POST while a single asset is read or deleted by its id.
  if (path === '/media/presign') {
    if (method === 'POST') return { ok: true, route: 'POST /media/presign', key: undefined };
    return { ok: false, status: 405 };
  }

  if (path === '/media') {
    if (method === 'POST') return { ok: true, route: 'POST /media', key: undefined };
    return { ok: false, status: 405 };
  }

  // Exactly one segment: `/media/a/b` is not a route, and `:id` is validated as
  // a UUID before it is ever joined into an object key.
  const media = /^\/media\/([^/]+)$/.exec(path);
  if (media !== null) {
    const key = media[1]!;
    if (method === 'GET') return { ok: true, route: 'GET /media/:id', key };
    if (method === 'DELETE') return { ok: true, route: 'DELETE /media/:id', key };
    return { ok: false, status: 405 };
  }

  // Search is per entity: index it (POST) or query it (GET).
  const search = /^\/search\/([^/]+)$/.exec(path);
  if (search !== null) {
    const key = decodeURIComponent(search[1]!);
    if (method === 'GET') return { ok: true, route: 'GET /search/:entity', key };
    if (method === 'POST') return { ok: true, route: 'POST /search/:entity', key };
    return { ok: false, status: 405 };
  }

  const setting = /^\/settings\/(.+)$/.exec(path);
  if (setting !== null) {
    if (method !== 'PUT') return { ok: false, status: 405 };
    return { ok: true, route: 'PUT /settings/:key', key: decodeURIComponent(setting[1]!) };
  }

  const feature = /^\/features\/(.+)$/.exec(path);
  if (feature !== null) {
    if (method !== 'PUT') return { ok: false, status: 405 };
    return { ok: true, route: 'PUT /features/:key', key: decodeURIComponent(feature[1]!) };
  }

  return { ok: false, status: 404 };
}

/**
 * What a committed transaction hands back: the response to send, plus the work
 * that may only happen *after* the commit.
 *
 * Deferring via thunks keeps the ordering impossible to get wrong - nothing in
 * `notifications` can run while the transaction is still open, because the
 * caller runs them after `execute()` resolves - while still typing each
 * `publish` call concretely.
 */
interface CommittedOutcome {
  readonly response: ApiResponse;
  readonly notifications: readonly (() => Promise<void>)[];
}
/** Input a client can fix: any of these becomes a 400, not a 500. */
function isSettingInputError(error: unknown): boolean {
  return (
    error instanceof SettingKeyError ||
    error instanceof SettingValueError ||
    error instanceof FeatureFlagKeyError ||
    error instanceof JobPayloadError ||
    error instanceof SearchInputError
  );
}

/** PostgreSQL unique-violation, reported as 409 exactly like SLATE-203. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/**
 * Builds the request handler.
 *
 * The returned function never throws for an expected rejection: validation,
 * authorization and uniqueness failures all come back as a response, so the
 * HTTP adapter stays a thin translation layer.
 */
export function createApi({
  db,
  logger,
  events,
  mediaEngine,
  searchEngine: search = postgresSearchEngine,
}: ApiOptions) {
  return async (request: ApiRequest): Promise<ApiResponse> => {
    const requestId = sanitizeRequestId(request.requestId);
    // Request-scoped child: every record below carries the id, so a browser
    // action and its audit row join in the log (Section 61, SLATE-301). The
    // local name avoids the `scoped` tenant-database helper declared below.
    const scopedLogger = requestId === undefined ? logger : logger.child({ requestId });
    const resolved = resolveTenantContext({
      principal: request.principal,
      requestedTenantId: request.tenantId,
    });
    if (!resolved.ok) {
      if (requestId !== undefined)
        scopedLogger.info('request rejected', { status: resolved.status });
      return withRequestId(
        { status: resolved.status, body: errorBody(resolved.status) },
        requestId,
      );
    }
    const { tenantId } = resolved.context;

    // A principal with no usable identity is rejected here, still before the
    // transaction: an empty user id could otherwise only fail inside the actor
    // lookup, which would cost a database round trip for a known-bad request.
    const principal = request.principal;
    if (principal === undefined || principal.userId.trim() === '') {
      if (requestId !== undefined) scopedLogger.info('request rejected', { status: 401 });
      return withRequestId({ status: 401, body: { error: 'Unauthenticated' } }, requestId);
    }

    // Routing and method rejection also happen before the transaction, so a
    // request that cannot be served costs no database round trip.
    try {
      const matched = matchRoute(request);
      if (!matched.ok) {
        if (requestId !== undefined)
          scopedLogger.info('request rejected', { status: matched.status });
        return withRequestId(
          { status: matched.status, body: errorBody(matched.status) },
          requestId,
        );
      }
      const { route, key } = matched;
      // Reject invalid configuration keys before even opening a transaction.
      if (route === 'PUT /settings/:key') assertSettingKey(key!);
      if (route === 'PUT /features/:key') assertKnownFeatureFlag(key!);
      // A search entity is a routing input, so it is validated here too: an
      // invalid one never reaches the actor lookup, let alone the index.
      if (route === 'GET /search/:entity' || route === 'POST /search/:entity')
        assertSearchEntity(key!);
      if (route === 'GET /search/:entity') inputSearchQuery(request.query);
      const outcome = await db.transaction().execute(async (trx): Promise<CommittedOutcome> => {
        // The tenant must belong to a real organization before anything is read
        // or written for it: a missing row is never silently tolerated.
        await resolveTenantOrganization(trx, tenantId);
        const auth = createAuth(trx);
        const actor = await auth.getCurrentUser(request.principal!.userId);
        if (!actor) throw new HttpError(401);
        if (
          !(await auth.hasPermission({
            userId: actor.id,
            tenantId,
            permission: ROUTE_PERMISSIONS[route],
          }))
        )
          throw new HttpError(403);

        const scoped = createTenantDatabase(trx, tenantId);
        const scopedLog = scopedLogger;
        const configuration = createTenantConfiguration(trx);

        /** Writes exactly one attributed audit row, inside this transaction. */
        const audit = async (
          action: string,
          resourceType: string,
          resourceId: string,
          payload: Record<string, unknown>,
        ): Promise<string> => {
          const row = await scoped
            .insertInto('audit_log', {
              actor_user_id: actor.id,
              action,
              resource_type: resourceType,
              resource_id: resourceId,
              payload,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          return row.id;
        };

        /** Post-commit work for a write: log the audit line, then announce it. */
        const afterWrite = (
          action: string,
          auditId: string,
          publish: () => Promise<void>,
        ): readonly (() => Promise<void>)[] => [
          () => {
            try {
              scopedLog.info('app.audit.recorded', {
                tenantId,
                actorUserId: actor.id,
                auditId,
                action,
              });
            } catch {
              // A logging failure must not fail an already committed write.
            }
            return Promise.resolve();
          },
          publish,
        ];
        switch (route) {
          case 'GET /users': {
            const users = await scoped
              .selectFrom('tenant_membership')
              .innerJoin('app_user', 'app_user.id', 'tenant_membership.app_user_id')
              .select(['app_user.id', 'app_user.email', 'app_user.display_name as name'])
              .orderBy('app_user.id')
              .limit(100)
              .execute();
            return { response: { status: 200, body: { users } }, notifications: [] };
          }

          case 'POST /users': {
            const input = inputUser(request.body);
            // Provision an inactive account; this scaffold provides no password login.
            const user = await trx
              .insertInto('app_user')
              .values({ ...input, password_hash: '', is_active: false })
              .returning(['id', 'email', 'display_name as name'])
              .executeTakeFirstOrThrow();
            await scoped
              .insertInto('tenant_membership', { app_user_id: user.id, role_id: null })
              .execute();
            const auditId = await audit('app.user.created', 'app_user', user.id, {
              userId: user.id,
            });
            return {
              response: { status: 201, body: { user } },
              notifications: afterWrite('app.user.created', auditId, async () => {
                await events.publish('app.user.created', {
                  tenantId,
                  userId: user.id,
                  actorUserId: actor.id,
                });
                await events.publish('app.audit.recorded', {
                  tenantId,
                  auditId,
                  actorUserId: actor.id,
                });
              }),
            };
          }

          case 'GET /settings': {
            // Server-authoritative: the tenant's own settings, read through the
            // scoped helper, so another tenant's rows are not reachable here.
            const settings = await configuration.settings.listSettings({ tenantId });
            return { response: { status: 200, body: { settings } }, notifications: [] };
          }

          case 'PUT /settings/:key': {
            const value = inputSettingValue(request.body);
            // An invalid key or an unstorable value is refused by the service
            // before any write, and mapped to a 400 below.
            const setting = await configuration.settings.setSetting({
              tenantId,
              key: key!,
              value,
            });
            const auditId = await audit('settings.updated', 'system_setting', setting.key, {
              key: setting.key,
            });
            return {
              response: { status: 200, body: { setting } },
              // The payload carries the KEY, never the value (Section 61).
              notifications: afterWrite('settings.updated', auditId, () =>
                events.publish('settings.updated', {
                  tenantId,
                  key: setting.key,
                  actorUserId: actor.id,
                }),
              ),
            };
          }

          case 'GET /features': {
            const features = await configuration.flags.resolveFeatureFlags({ tenantId });
            return { response: { status: 200, body: { features } }, notifications: [] };
          }

          case 'GET /jobs': {
            const query = request.query ?? {};
            const page = await listJobs(trx, {
              tenantId,
              limit: optionalInteger(query['limit']),
              status: query['status'],
              cursor: query['cursor'],
            });
            return { response: { status: 200, body: page }, notifications: [] };
          }

          case 'GET /jobs/:id': {
            // A foreign job id and a missing one are the same 404; the summary
            // allowlist never carries payload, idempotency key or lease data.
            const job = await getJob(trx, { tenantId, jobId: key! });
            if (job === null) throw new HttpError(404);
            return { response: { status: 200, body: { job } }, notifications: [] };
          }

          case 'PUT /features/:key': {
            const enabled = inputFeatureFlagEnabled(request.body);
            // An undeclared key is refused, so a client can never switch on
            // behaviour nobody declared (Section 60); `null` clears the override
            // and reverts the tenant to the registry default.
            const resolution =
              enabled === null
                ? await configuration.flags.clearFeatureFlag({
                    tenantId,
                    key: key as FeatureFlagKey,
                  })
                : await configuration.flags.setFeatureFlag({
                    tenantId,
                    key: key as FeatureFlagKey,
                    enabled,
                  });
            const auditId = await audit('feature.flag.updated', 'feature_flag', resolution.key, {
              key: resolution.key,
            });
            return {
              response: {
                status: 200,
                body: { key: resolution.key, enabled: resolution.enabled },
              },
              // The payload carries the KEY, never the resolved state.
              notifications: afterWrite('feature.flag.updated', auditId, () =>
                events.publish('feature.flag.updated', {
                  tenantId,
                  key: resolution.key,
                  actorUserId: actor.id,
                }),
              ),
            };
          }
          case 'POST /media/presign': {
            // `mimeType` and `originalName` are validated for shape but not used
            // here: the completer sends them again when it registers the file.
            const { category } = inputMediaPresign(request.body);
            // The object key is generated here, never supplied by the client.
            const id = randomUUID();
            const { path, url } = await mediaEngine.getUploadUrl(tenantId, category, id);
            return {
              response: {
                status: 200,
                body: { id, path, url, expiresIn: PRESIGN_EXPIRES_IN_SECONDS },
              },
              // A presign changes nothing that needs announcing: no row and no
              // bytes exist until the upload completes.
              notifications: [],
            };
          }
          case 'POST /media': {
            const { id, category, mimeType, size, originalName } = inputMediaUpload(request.body);
            // Rebuilt from trusted values, so the completed upload can only land
            // under this tenant's prefix, and the object must already be there:
            // a client cannot claim a file that was never uploaded.
            const path = mediaPath(tenantId, category, id);
            if (!(await mediaEngine.exists(tenantId, path))) throw new HttpError(400);
            const auditId = await audit('media.uploaded', 'media_file', id, { tenantId, path });
            await trx
              .insertInto('media_files')
              .values({
                id,
                tenant_id: tenantId,
                storage_path: path,
                mime_type: mimeType,
                size: size.toString(),
                original_name: originalName,
              })
              .execute();
            return {
              response: { status: 201, body: { id, path, mimeType, size, originalName } },
              notifications: afterWrite('media.uploaded', auditId, () =>
                events.publish('media.uploaded', { tenantId, fileId: id, actorUserId: actor.id }),
              ),
            };
          }
          case 'GET /media/:id': {
            const mediaId = key!;
            const row = await trx
              .selectFrom('media_files')
              .selectAll()
              .where('id', '=', mediaId)
              .where('tenant_id', '=', tenantId)
              .executeTakeFirst();
            if (!row) throw new HttpError(404);
            const url = await mediaEngine.getDownloadUrl(tenantId, row.storage_path);
            return {
              response: {
                status: 200,
                body: {
                  url,
                  mimeType: row.mime_type,
                  size: Number(row.size),
                  originalName: row.original_name,
                },
              },
              notifications: [],
            };
          }
          case 'DELETE /media/:id': {
            const mediaId = key!;
            const row = await trx
              .selectFrom('media_files')
              .selectAll()
              .where('id', '=', mediaId)
              .where('tenant_id', '=', tenantId)
              .executeTakeFirst();
            if (!row) throw new HttpError(404);
            await mediaEngine.deleteFile(tenantId, row.storage_path);
            const auditId = await audit('media.deleted', 'media_file', mediaId, {
              tenantId,
              path: row.storage_path,
            });
            await trx.deleteFrom('media_files').where('id', '=', mediaId).execute();
            return {
              response: { status: 204, body: null },
              notifications: afterWrite('media.deleted', auditId, () =>
                events.publish('media.deleted', {
                  tenantId,
                  fileId: mediaId,
                  actorUserId: actor.id,
                }),
              ),
            };
          }
          // End of media routes

          case 'POST /search/:entity': {
            // Index (upsert) one document and audit it in the same transaction:
            // a search index row that exists without its audit line is as wrong
            // as an audit line for a row that was rolled back.
            const input = inputSearchIndex(request.body);
            const indexed = await search.index(trx, {
              tenantId,
              entity: key!,
              recordId: input.recordId,
              title: input.title,
              body: input.body,
            });
            const auditId = await audit('search.indexed', 'search_document', indexed.id, {
              entity: indexed.entity,
              recordId: indexed.recordId,
            });
            return {
              // 201 only distinguishes nothing: an upsert answers the same shape
              // whether it created the row or replaced its text.
              response: {
                status: 201,
                body: { entity: indexed.entity, recordId: indexed.recordId },
              },
              // The bus hears WHICH document changed, never its text (Section 61).
              notifications: afterWrite('search.indexed', auditId, () =>
                events.publish('search.indexed', {
                  tenantId,
                  entity: indexed.entity,
                  actorUserId: actor.id,
                }),
              ),
            };
          }
          case 'GET /search/:entity': {
            // Ranked, tenant-scoped full-text query. The audit row makes every
            // read attributable, in the same transaction as the read itself.
            const { q, limit } = inputSearchQuery(request.query);
            const hits = await search.query(trx, { tenantId, entity: key!, q, limit });
            await audit('search.query', 'search_document', key!, { entity: key!, query: q });
            return {
              response: { status: 200, body: { entity: key!, query: q, count: hits.length, hits } },
              notifications: [],
            };
          }
        }
      });

      // Past this point the transaction has committed. Only now may the audit
      // line be logged and the events be published, so a write that rolled back
      // can never announce itself.
      for (const notify of outcome.notifications) await notify();
      return withRequestId(outcome.response, requestId);
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof URIError || isSettingInputError(error)
            ? 400
            : isUniqueViolation(error)
              ? 409
              : 500;
      if (status === 500) {
        try {
          scopedLogger.error('request failed', { path: request.path, method: request.method });
        } catch {
          /* sink failure */
        }
      } else if (requestId !== undefined) {
        try {
          scopedLogger.info('request rejected', { status });
        } catch {
          /* sink failure */
        }
      }
      return withRequestId({ status, body: errorBody(status) }, requestId);
    }
  };
}
