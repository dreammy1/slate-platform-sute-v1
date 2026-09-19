import { describe, expect, it } from 'vitest';

import { createApiClient } from './client.ts';
import {
  ApiClientUsageError,
  API_PREFIX,
  apiPath,
  assertNoTenantInput,
  buildQuery,
  routes,
  stripApiPrefix,
  TENANT_INPUT_NAMES,
} from './routes.ts';
import { errorMessageFor, kindForStatus } from './errors.ts';

describe('route helpers', () => {
  it('prefixes the versioned mount point exactly once', () => {
    expect(API_PREFIX).toBe('/api/v1');
    expect(stripApiPrefix('/api/v1/users')).toBe('/users');
    expect(stripApiPrefix('/api/v1')).toBe('/');
    expect(stripApiPrefix('/users')).toBeUndefined();
    expect(stripApiPrefix('/api/v10/users')).toBeUndefined();
  });

  it('refuses an absolute URL and a double prefix as programmer errors', () => {
    expect(() => apiPath('https://evil.example/users')).toThrow(ApiClientUsageError);
    expect(() => apiPath(`${API_PREFIX}/users`)).toThrow(ApiClientUsageError);
    expect(apiPath('/users')).toBe(`${API_PREFIX}/users`);
    expect(apiPath('users')).toBe(`${API_PREFIX}/users`);
  });

  it('refuses any input that tries to name a tenant (Master Plan Section 13)', () => {
    expect(() => assertNoTenantInput({ tenantId: 't' }, 'body')).toThrow(ApiClientUsageError);
    expect(() => assertNoTenantInput({ TENANT_ID: 't' }, 'body')).toThrow(ApiClientUsageError);
    expect(() => assertNoTenantInput({ organization_id: 'o' }, 'body')).toThrow(
      ApiClientUsageError,
    );
    expect(TENANT_INPUT_NAMES).toContain('x-tenant-id');
    // Legitimate payloads pass untouched.
    expect(() => assertNoTenantInput({ email: 'a@b.test' }, 'body')).not.toThrow();
  });

  it('builds a stable, sorted query string and drops undefined values', () => {
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ b: 2, a: 1, gone: undefined })).toBe('?a=1&b=2');
    expect(() => buildQuery({ tenantId: 't' })).toThrow(ApiClientUsageError);
  });

  it('spells every endpoint the shell uses, with encoding where it matters', () => {
    expect(routes.users).toBe('/users');
    expect(routes.setting('feature.restaurant.v1')).toBe('/settings/feature.restaurant.v1');
    expect(routes.job('j1')).toBe('/jobs/j1');
    expect(routes.healthReady).toBe('/health/ready');
  });
});

describe('typed error union', () => {
  it('maps every documented status onto a kind the UI can branch on', () => {
    expect(kindForStatus(400)).toBe('bad_request');
    expect(kindForStatus(401)).toBe('unauthenticated');
    expect(kindForStatus(403)).toBe('forbidden');
    expect(kindForStatus(404)).toBe('not_found');
    expect(kindForStatus(409)).toBe('conflict');
    expect(kindForStatus(413)).toBe('too_large');
    expect(kindForStatus(415)).toBe('unsupported_media_type');
    expect(kindForStatus(500)).toBe('server');
    expect(kindForStatus(503)).toBe('server');
    expect(kindForStatus(418)).toBe('unexpected');
  });

  it('keeps 403 and 404 distinct — the platform hides existence behind denial', () => {
    expect(kindForStatus(403)).not.toBe(kindForStatus(404));
  });

  it('prefers the API error string, then the status text, then a synthesized one', () => {
    expect(errorMessageFor(403, { error: 'Not allowed' }, '')).toBe('Not allowed');
    expect(errorMessageFor(404, {}, 'Not Found')).toBe('Not Found');
    expect(errorMessageFor(500, {}, '')).toBe('Request failed with status 500');
    expect(errorMessageFor(500, { error: 42 }, 'Boom')).toBe('Boom');
  });
});

/** A capture of one fetch invocation. */
interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fetchStub(response: Response | ((call: RecordedCall) => Response)) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = { url: String(input), init };
    calls.push(call);
    return typeof response === 'function' ? response(call) : response;
  }) as unknown as typeof globalThis.fetch;
  return { calls, impl };
}

describe('the browser client', () => {
  it('sends the request id header and echoes the server value into the result', async () => {
    const { calls, impl } = fetchStub(
      () =>
        new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { 'x-request-id': 'srv-9' },
        }),
    );
    const client = createApiClient({ fetch: impl, newRequestId: () => 'req-fixed' });

    const result = await client.get('/users');

    expect(result).toMatchObject({ ok: true, status: 200, requestId: 'srv-9' });
    if (result.ok) expect(result.data).toEqual({ users: [] });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('x-request-id')).toBe('req-fixed');
    expect(calls[0]?.url).toBe(`${API_PREFIX}/users`);
  });

  it('posts JSON with a content type and never sends one on a GET', async () => {
    const { calls, impl } = fetchStub(() => new Response(null, { status: 201 }));
    const client = createApiClient({ fetch: impl });

    await client.post('/users', { email: 'a@b.test', name: 'A' });
    await client.get('/users');

    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/json');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ email: 'a@b.test', name: 'A' }));
    expect(new Headers(calls[1]?.init?.headers).get('content-type')).toBeNull();
  });

  it('turns an HTTP failure into a result instead of a rejection', async () => {
    const { impl } = fetchStub(
      () => new Response(JSON.stringify({ error: 'Not allowed' }), { status: 403 }),
    );
    const client = createApiClient({ fetch: impl });

    const result = await client.request({ method: 'GET', path: '/users' });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      kind: 'forbidden',
      message: 'Not allowed',
    });
  });

  it('maps a transport failure to the transport kind without throwing', async () => {
    const impl = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof globalThis.fetch;
    const client = createApiClient({ fetch: impl });

    const result = await client.get('/users');

    expect(result).toMatchObject({ ok: false, status: 0, kind: 'transport' });
  });

  it('hard-fails on a tenant in the payload and on a double prefix', async () => {
    const { impl } = fetchStub(() => new Response('null', { status: 200 }));
    const client = createApiClient({ fetch: impl });

    await expect(client.post('/users', { tenantId: 't' })).rejects.toThrow(ApiClientUsageError);
    await expect(client.request({ method: 'GET', path: `${API_PREFIX}/users` })).rejects.toThrow(
      ApiClientUsageError,
    );
  });

  it('stays cache-safe for tenant data and cookie-first-party', async () => {
    const { calls, impl } = fetchStub(() => new Response('null', { status: 200 }));
    const client = createApiClient({ fetch: impl });
    await client.get('/users');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(
      (calls[0]?.init as (RequestInit & { credentials?: string }) | undefined)?.credentials,
    ).toBe('same-origin');
  });

  it('reuses a caller-provided request id so a logged action can be correlated', async () => {
    const { calls, impl } = fetchStub(() => new Response('null', { status: 200 }));
    const client = createApiClient({ fetch: impl, newRequestId: () => 'generated' });
    await client.request({ method: 'GET', path: '/users', requestId: 'given' });
    expect(new Headers(calls[0]?.init?.headers).get('x-request-id')).toBe('given');
  });

  it('passes an abort signal through to the transport', async () => {
    const { calls, impl } = fetchStub(() => new Response('null', { status: 200 }));
    const client = createApiClient({ fetch: impl });
    const controller = new AbortController();
    await client.request({ method: 'GET', path: '/users', signal: controller.signal });
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it('tolerates an empty body on a 204-style answer', async () => {
    const { impl } = fetchStub(() => new Response(null, { status: 200 }));
    const client = createApiClient({ fetch: impl });
    const result = await client.get('/users');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeUndefined();
  });

  it('falls back to the status text when a failure body is not JSON', async () => {
    const { impl } = fetchStub(
      () => new Response('<html>gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const client = createApiClient({ fetch: impl });
    const result = await client.get('/users');
    expect(result).toMatchObject({
      ok: false,
      status: 502,
      kind: 'server',
      message: 'Bad Gateway',
    });
  });
});
