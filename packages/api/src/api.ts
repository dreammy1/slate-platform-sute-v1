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
}
export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}
export interface ApiOptions {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly events: EventBus;
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
    error instanceof JobPayloadError
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
export function createApi({ db, logger, events }: ApiOptions) {
  return async (request: ApiRequest): Promise<ApiResponse> => {
    const resolved = resolveTenantContext({
      principal: request.principal,
      requestedTenantId: request.tenantId,
    });
    if (!resolved.ok) return { status: resolved.status, body: errorBody(resolved.status) };
    const { tenantId } = resolved.context;

    // A principal with no usable identity is rejected here, still before the
    // transaction: an empty user id could otherwise only fail inside the actor
    // lookup, which would cost a database round trip for a known-bad request.
    const principal = request.principal;
    if (principal === undefined || principal.userId.trim() === '') {
      return { status: 401, body: { error: 'Unauthenticated' } };
    }

    // Routing and method rejection also happen before the transaction, so a
    // request that cannot be served costs no database round trip.
    try {
      const matched = matchRoute(request);
      if (!matched.ok) return { status: matched.status, body: errorBody(matched.status) };
      const { route, key } = matched;
      // Reject invalid configuration keys before even opening a transaction.
      if (route === 'PUT /settings/:key') assertSettingKey(key!);
      if (route === 'PUT /features/:key') assertKnownFeatureFlag(key!);
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
              logger.info('app.audit.recorded', {
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
        }
      });

      // Past this point the transaction has committed. Only now may the audit
      // line be logged and the events be published, so a write that rolled back
      // can never announce itself.
      for (const notify of outcome.notifications) await notify();
      return outcome.response;
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
          logger.error('request failed', { path: request.path, method: request.method });
        } catch {
          /* sink failure */
        }
      }
      return { status, body: errorBody(status) };
    }
  };
}
