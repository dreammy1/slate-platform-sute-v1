/**
 * Tenant switch (SLATE-301 flow, used by the SLATE-302 shell; ADR 009 §3).
 *
 * The browser names a tenant; the server re-reads membership and refuses a
 * non-member (403) rather than re-scoping. On success the session is re-issued
 * with the same cookie attributes and the switch is audited.
 */

import { NextResponse } from 'next/server';

import { isValidTenantId } from '@slate/database';
import { SESSION_COOKIE_NAME } from '@slate/api-client/server';

import { platformRuntime } from '@/server/platform';

export const dynamic = 'force-dynamic';

function readCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (header === null) return undefined;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === SESSION_COOKIE_NAME) return pair.slice(index + 1).trim();
  }
  return undefined;
}

export async function POST(request: Request): Promise<Response> {
  const home = NextResponse.redirect(new URL('/', request.url), 303);
  const runtime = await platformRuntime();
  if (runtime === undefined) return home;

  const payload = runtime.codec.verify(readCookie(request));
  if (payload === undefined) return home;

  const form = await request.formData();
  const field = form.get('tenantId');
  const requested = typeof field === 'string' ? field.trim() : '';
  if (requested === '' || !isValidTenantId(requested)) return home;

  const membership = await runtime.db
    .selectFrom('tenant_membership')
    .select('tenant_id')
    .where('app_user_id', '=', payload.userId)
    .where('tenant_id', '=', requested)
    .executeTakeFirst();
  if (membership === undefined) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const previous = payload.tenantId;
  await runtime.db
    .insertInto('audit_log')
    .values({
      tenant_id: membership.tenant_id,
      actor_user_id: payload.userId,
      action: 'session.tenant.switched',
      resource_type: 'tenant',
      resource_id: membership.tenant_id,
      payload: { previousTenantId: previous ?? null },
    })
    .execute();

  const response = NextResponse.redirect(new URL('/', request.url), 303);
  response.headers.append(
    'set-cookie',
    runtime.codec.cookie(
      runtime.codec.issue({ userId: payload.userId, tenantId: membership.tenant_id }),
    ),
  );
  return response;
}
