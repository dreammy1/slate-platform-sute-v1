/**
 * System health dashboard data (SLATE-302, ADR 010 §5).
 *
 * A read-only projection of the probes that already exist. The report carries a
 * status word and the probe's HTTP status only — never a stack trace, connection
 * string or raw error body, so the dashboard can never become an information
 * leak (Sections 58, 61).
 */

import type { Kysely } from 'kysely';

import { healthLive, healthReady } from '@slate/api';
import type { Database } from '@slate/database';

/** The two states a probe reduces to. */
export type ProbeState = 'healthy' | 'unavailable';

/** One probe row the dashboard renders. */
export interface HealthProbe {
  readonly id: 'live' | 'ready';
  readonly label: string;
  readonly state: ProbeState;
  /** HTTP status the probe answered with; the only detail that is exposed. */
  readonly status: number;
}

/** The dashboard payload. */
export interface HealthSnapshot {
  readonly probes: readonly HealthProbe[];
  readonly checkedAt: string;
  readonly status: ProbeState;
}

/** Maps a probe's HTTP status onto the two states the UI renders. Pure. */
export function probeState(status: number): ProbeState {
  return status === 200 ? 'healthy' : 'unavailable';
}

/**
 * Builds the dashboard payload from two raw probe statuses. Pure and total: the
 * only data that crosses into the report is a state word and the HTTP status, so
 * no error detail can leak through this path (Section 61).
 */
export function buildSnapshot(
  liveStatus: number,
  readyStatus: number,
  checkedAt: string,
): HealthSnapshot {
  const probes: readonly HealthProbe[] = [
    { id: 'live', label: 'Liveness', state: probeState(liveStatus), status: liveStatus },
    { id: 'ready', label: 'Readiness', state: probeState(readyStatus), status: readyStatus },
  ];
  return {
    probes,
    checkedAt,
    status: probes.every((probe) => probe.state === 'healthy') ? 'healthy' : 'unavailable',
  };
}

/**
 * Collects the live and ready probes server-side. Liveness touches nothing;
 * readiness checks the database. A failure reduces to `unavailable` through
 * {@link buildSnapshot}; the detail stays in the logs (ADR 007, ADR 010 §5).
 */
export async function collectHealthSnapshot(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): Promise<HealthSnapshot> {
  const live = healthLive();
  const ready = await healthReady(db);
  return buildSnapshot(live.status, ready.status, now().toISOString());
}
