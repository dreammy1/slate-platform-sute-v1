import { sql, type Kysely } from 'kysely';

import type { Database } from '@slate/database';

import type { ApiResponse } from './api.ts';

/**
 * Kubernetes-style health probes (SLATE-208, ADR 007).
 *
 * Liveness answers "is this process running?" and deliberately touches nothing:
 * a dependency that is down must not get an orchestrator to kill a healthy
 * process, so liveness never reaches the database. Readiness answers "can this
 * process serve traffic?" and therefore checks every dependency serving traffic
 * needs — today, the database.
 *
 * Both are unauthenticated by design (an orchestrator has no session) and both
 * disclose no configuration, version or error detail: the body is a single
 * status word, so a probe can never become an information leak.
 */

/** Route the process answers before authentication and tenant resolution. */
export const HEALTH_LIVE_PATH = '/health/live';
export const HEALTH_READY_PATH = '/health/ready';

/** True for either probe path, normalized the way routing normalizes paths. */
export function isHealthRoute(path: string): boolean {
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return normalized === HEALTH_LIVE_PATH || normalized === HEALTH_READY_PATH;
}

const LIVE: ApiResponse = { status: 200, body: { status: 'live' } };

/** Liveness: the process is up. No dependency is consulted. */
export function healthLive(): ApiResponse {
  return LIVE;
}

/** Readiness: 200 when the database answers, 503 when it does not. */
export async function healthReady(db: Kysely<Database>): Promise<ApiResponse> {
  try {
    // The cheapest possible round trip; its failure is the only signal needed.
    await sql`select 1`.execute(db);
    return { status: 200, body: { status: 'ready' } };
  } catch {
    // The detail stays in the logs, never in the probe response.
    return { status: 503, body: { status: 'unavailable' } };
  }
}
