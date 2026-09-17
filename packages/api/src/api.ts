import type { Kysely } from 'kysely';
import { createAuth } from '@slate/auth';
import { createTenantDatabase, type Database } from '@slate/database';
import {
  resolveTenantContext,
  resolveTenantOrganization,
  type AuthenticatedPrincipal,
} from '@slate/tenant-context';
import type { Logger } from '@slate/observability';
import type { EventBus } from './events.ts';

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  /** Injected by trusted session middleware, NEVER deserialized from the request body. */
  readonly principal: AuthenticatedPrincipal | undefined;
  readonly tenantId: string | undefined;
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

export function createApi({ db, logger, events }: ApiOptions) {
  return async (request: ApiRequest): Promise<ApiResponse> => {
    const resolved = resolveTenantContext({
      principal: request.principal,
      requestedTenantId: request.tenantId,
    });
    if (!resolved.ok)
      return { status: resolved.status, body: { error: 'Unauthorized tenant context' } };
    const principal = request.principal;
    if (!principal || !principal.userId.trim())
      return { status: 401, body: { error: 'Unauthenticated' } };
    if (request.path !== '/users') return { status: 404, body: { error: 'Not found' } };
    if (!['GET', 'POST'].includes(request.method))
      return { status: 405, body: { error: 'Method not allowed' } };
    const { tenantId } = resolved.context;
    try {
      const outcome = await db.transaction().execute(async (trx) => {
        await resolveTenantOrganization(trx, tenantId);
        const auth = createAuth(trx);
        const actor = await auth.getCurrentUser(principal.userId);
        if (!actor) throw new HttpError(401);
        if (
          !(await auth.hasPermission({
            userId: actor.id,
            tenantId,
            permission: request.method === 'GET' ? 'users.read' : 'users.write',
          }))
        )
          throw new HttpError(403);
        const scoped = createTenantDatabase(trx, tenantId);
        if (request.method === 'GET') {
          const users = await scoped
            .selectFrom('tenant_membership')
            .innerJoin('app_user', 'app_user.id', 'tenant_membership.app_user_id')
            .select(['app_user.id', 'app_user.email', 'app_user.display_name as name'])
            .orderBy('app_user.id')
            .limit(100)
            .execute();
          return { response: { status: 200, body: { users } }, created: undefined };
        }
        const input = inputUser(request.body);
        // Provision an inactive account; this scaffold does not provide password login.
        const user = await trx
          .insertInto('app_user')
          .values({ ...input, password_hash: '', is_active: false })
          .returning(['id', 'email', 'display_name as name'])
          .executeTakeFirstOrThrow();
        await scoped
          .insertInto('tenant_membership', { app_user_id: user.id, role_id: null })
          .execute();
        const audit = await scoped
          .insertInto('audit_log', {
            actor_user_id: actor.id,
            action: 'app.user.created',
            resource_type: 'app_user',
            resource_id: user.id,
            payload: { userId: user.id },
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return {
          response: { status: 201, body: { user } },
          created: { userId: user.id, actorUserId: actor.id, auditId: audit.id },
        };
      });
      if (outcome.created) {
        const { userId, actorUserId, auditId } = outcome.created;
        try {
          logger.info('app.audit.recorded', {
            tenantId,
            actorUserId,
            auditId,
            payload: { userId },
          });
        } catch {
          /* committed write */
        }
        await events.publish('app.user.created', { tenantId, userId, actorUserId });
        await events.publish('app.audit.recorded', { tenantId, auditId, actorUserId });
      }
      return outcome.response;
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
            ? 409
            : 500;
      return {
        status,
        body: { error: status === 500 ? 'Internal server error' : 'Request rejected' },
      };
    }
  };
}
