/**
 * Sign-out (SLATE-301 flow, used by the SLATE-302 shell; ADR 009 §4).
 *
 * The server clears the session cookie; the browser never manipulates it.
 */

import { NextResponse } from 'next/server';

import { SESSION_COOKIE_NAME } from '@slate/api-client/server';

import { platformRuntime } from '@/server/platform';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const response = NextResponse.redirect(new URL('/', request.url), 303);
  const runtime = await platformRuntime();
  response.headers.append(
    'set-cookie',
    runtime === undefined
      ? `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
      : runtime.codec.clearCookie(),
  );
  return response;
}
