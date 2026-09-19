/**
 * The versioned platform API mount (SLATE-300, ADR 008 §5): `createHttpHandler`
 * served at `/api/v1/[...path]` on the app's own origin, so the session cookie
 * is first-party and the browser client's prefix (`/api/v1`) matches the route.
 *
 * This is one of the app's two designated server zones (see the ESLint boundary
 * rules): the Next.js request/response objects are adapted to the node shapes
 * the platform handler speaks, and the platform's responses are copied back.
 */

import { platformRuntime } from '@/server/platform';

export const dynamic = 'force-dynamic';

/** Minimal node-shaped request the platform handler can consume. */
function toNodeRequest(request: Request) {
  const url = new URL(request.url);
  return {
    url: `${url.pathname}${url.search}`,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    async *[Symbol.asyncIterator]() {
      const body = await request.arrayBuffer();
      if (body.byteLength > 0) yield Buffer.from(body);
    },
  } as unknown as import('node:http').IncomingMessage;
}

/** The node-shaped response the platform writes into, as a web `Response`. */
interface NodeResponseLike {
  status: number;
  headers: Record<string, string | string[]>;
  chunks: string[];
  writeHead(status: number, headers: Record<string, string | string[]>): unknown;
  end(body?: unknown): unknown;
}

function createNodeResponse(): NodeResponseLike {
  return {
    status: 500,
    headers: {},
    chunks: [],
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(body) {
      if (body !== undefined) this.chunks.push(String(body));
      return this;
    },
  };
}

async function bridge(request: Request): Promise<Response> {
  const runtime = await platformRuntime();
  if (runtime === undefined) {
    return Response.json({ error: 'Platform not configured' }, { status: 503 });
  }
  const nodeResponse = createNodeResponse();
  await runtime.handler(
    toNodeRequest(request) as import('node:http').IncomingMessage,
    nodeResponse as unknown as import('node:http').ServerResponse,
  );
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeResponse.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  return new Response(nodeResponse.chunks.join(''), { status: nodeResponse.status, headers });
}

export const GET = bridge;
export const POST = bridge;
export const PUT = bridge;
export const PATCH = bridge;
export const DELETE = bridge;
