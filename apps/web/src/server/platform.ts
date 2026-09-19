/**
 * The admin app's server wiring (SLATE-300, ADR 008 §5) — one of the two
 * designated server zones in the app. Everything the platform needs on the
 * app's origin is constructed here, lazily and from the environment, so a
 * missing configuration is a runtime 503 rather than a build failure.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createEventBus, createHttpHandler } from '@slate/api';
import { createDatabase, type Database } from '@slate/database';
import { FileSystemStorageProvider, MediaEngine } from '@slate/media';
import { createLogger, type Logger } from '@slate/observability';
import type { Kysely } from 'kysely';
import type { AuthenticatedPrincipal } from '@slate/tenant-context';
import { SESSION_COOKIE_NAME, createSessionCodec } from '@slate/api-client/server';

/** Every variable the mounted platform needs; absent entries disable serving. */
export type PlatformEnvironment = Readonly<Record<string, string | undefined>>;

interface PlatformRuntime {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  readonly db: Kysely<Database>;
}

let runtimePromise: Promise<PlatformRuntime | undefined> | undefined;

/** Reads the session cookie value out of a node request's header map. */
function sessionCookie(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name === SESSION_COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}

/** Parses the platform handler lazily; a missing variable yields `undefined`. */
async function buildRuntime(
  env: PlatformEnvironment,
  logger: Logger,
): Promise<PlatformRuntime | undefined> {
  const databaseUrl = env['DATABASE_URL'];
  const sessionSecret = env['SESSION_SECRET'];
  if (databaseUrl === undefined || sessionSecret === undefined) return undefined;

  const db = createDatabase({ url: databaseUrl, env, logger });
  const events = createEventBus(logger);
  const mediaRoot = env['SLATE_MEDIA_ROOT'] ?? join(tmpdir(), 'slate-web-media');
  const mediaEngine = new MediaEngine(new FileSystemStorageProvider(mediaRoot), logger);
  const codec = createSessionCodec({ secret: sessionSecret });

  const handler = createHttpHandler({
    db,
    logger,
    events,
    mediaEngine,
    // Middleware verifies the session and resolves the principal from the
    // database; the tenant header is only honoured when the principal is a
    // member — the pipeline refuses it otherwise (Master Plan Section 13).
    authenticate: async (request) => {
      const token = sessionCookie(request);
      if (token === undefined) return undefined;
      const payload = codec.verify(token);
      if (payload === undefined) return undefined;

      const tenantHeader = request.headers['x-tenant-id'];
      const requested =
        (Array.isArray(tenantHeader) ? tenantHeader[0] : tenantHeader) ?? payload.tenantId;
      if (requested === undefined) return undefined;

      const memberships = await db
        .selectFrom('tenant_membership')
        .select('tenant_id')
        .where('app_user_id', '=', payload.userId)
        .execute();
      const tenantIds = memberships.map((row) => row.tenant_id);
      if (!tenantIds.includes(requested)) return undefined;

      const principal: AuthenticatedPrincipal = {
        userId: payload.userId,
        tenantIds,
        activeTenantId: requested,
      };
      return principal;
    },
  });

  return { handler, db };
}

/**
 * Returns the runtime, building it on first use. `undefined` means the
 * environment is incomplete — callers answer 503 instead of guessing.
 */
export function platformRuntime(
  env: PlatformEnvironment = process.env,
): Promise<PlatformRuntime | undefined> {
  runtimePromise ??= buildRuntime(env, createLogger({ env }));
  return runtimePromise;
}
