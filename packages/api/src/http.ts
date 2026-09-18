import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthenticatedPrincipal } from '@slate/tenant-context';
import { createApi, type ApiOptions, type ApiResponse } from './api.ts';

export interface HttpOptions extends ApiOptions {
  /** Verify the session server-side. Do not build a principal from client-supplied IDs. */
  readonly authenticate: (request: IncomingMessage) => Promise<AuthenticatedPrincipal | undefined>;
}
const MAX_BODY_BYTES = 16_384;

/** Request path without the query string, which routing never inspects. */
function pathFor(request: IncomingMessage): string {
  const url = request.url ?? '/';
  const withoutQuery = url.split('?')[0] ?? '/';
  return withoutQuery === '' ? '/' : withoutQuery;
}

/** Decoded query parameters; duplicates join, which the routes re-validate. */
function queryFor(request: IncomingMessage): Record<string, string> {
  const raw = request.url?.split('?')[1] ?? '';
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * Verbs a known path accepts, for the `Allow` header on a 405.
 *
 * Derived from the path rather than hard-coded to one route, so the header stays
 * truthful now that `/settings` and `/features` are served too.
 */
function allowedVerbs(path: string): string | undefined {
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (normalized === '/users') return 'GET, POST';
  if (normalized === '/settings' || normalized === '/features' || normalized === '/jobs')
    return 'GET';
  if (normalized.startsWith('/settings/') || normalized.startsWith('/features/')) return 'PUT';
  if (normalized.startsWith('/jobs/')) return 'GET';
  if (normalized === '/media' || normalized === '/media/presign') return 'POST';
  if (normalized.startsWith('/media/')) return 'GET, DELETE';

  return undefined;
}

/** Node HTTP adapter. No listener is opened until the host application chooses to do so. */
export function createHttpHandler(options: HttpOptions) {
  const api = createApi(options);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (result: ApiResponse) => {
      const allow = result.status === 405 ? allowedVerbs(pathFor(request)) : undefined;
      response.writeHead(result.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(allow === undefined ? {} : { allow }),
      });
      response.end(JSON.stringify(result.body));
    };
    try {
      const principal = await options.authenticate(request);
      const tenantHeader = request.headers['x-tenant-id'];
      // Duplicate tenant headers must not be interpreted as a tenant selection.
      const tenantId = Array.isArray(tenantHeader) ? tenantHeader.join(',') : tenantHeader;
      const method = request.method ?? 'GET';
      const path = pathFor(request);
      let body: unknown;
      // A mutation may carry a body on POST or PUT; a GET never does.
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        if (
          request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !==
          'application/json'
        ) {
          send({ status: 415, body: { error: 'Expected application/json' } });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          size += buffer.length;
          if (size > MAX_BODY_BYTES) {
            send({ status: 413, body: { error: 'Request body too large' } });
            return;
          }
          chunks.push(buffer);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } catch {
          send({ status: 400, body: { error: 'Invalid JSON' } });
          return;
        }
      }
      send(await api({ method, path, principal, tenantId, query: queryFor(request), body }));
    } catch {
      if (!response.headersSent) send({ status: 500, body: { error: 'Internal server error' } });
      else response.end();
    }
  };
}
