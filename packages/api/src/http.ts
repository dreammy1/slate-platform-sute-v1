import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthenticatedPrincipal } from '@slate/tenant-context';
import { createApi, type ApiOptions, type ApiResponse } from './api.ts';

export interface HttpOptions extends ApiOptions {
  /** Verify the session server-side. Do not build a principal from client-supplied IDs. */
  readonly authenticate: (request: IncomingMessage) => Promise<AuthenticatedPrincipal | undefined>;
}
const MAX_BODY_BYTES = 16_384;

/** Node HTTP adapter. No listener is opened until the host application chooses to do so. */
export function createHttpHandler(options: HttpOptions) {
  const api = createApi(options);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (result: ApiResponse) => {
      response.writeHead(result.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(result.status === 405 ? { allow: 'GET, POST' } : {}),
      });
      response.end(JSON.stringify(result.body));
    };
    try {
      const principal = await options.authenticate(request);
      const tenantHeader = request.headers['x-tenant-id'];
      // Duplicate tenant headers must not be interpreted as a tenant selection.
      const tenantId = Array.isArray(tenantHeader) ? tenantHeader.join(',') : tenantHeader;
      const method = request.method ?? 'GET';
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      let body: unknown;
      if (method === 'POST') {
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
      send(await api({ method, path, principal, tenantId, body }));
    } catch {
      if (!response.headersSent) send({ status: 500, body: { error: 'Internal server error' } });
      else response.end();
    }
  };
}
