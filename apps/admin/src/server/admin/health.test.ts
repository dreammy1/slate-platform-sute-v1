import { describe, expect, it } from 'vitest';

import { buildSnapshot, probeState } from './health.ts';

describe('probeState', () => {
  it('maps 200 to healthy and every other status to unavailable', () => {
    expect(probeState(200)).toBe('healthy');
    expect(probeState(204)).toBe('unavailable');
    expect(probeState(500)).toBe('unavailable');
    expect(probeState(503)).toBe('unavailable');
  });
});

describe('buildSnapshot', () => {
  it('reports healthy only when every probe is healthy', () => {
    const healthy = buildSnapshot(200, 200, '2026-09-20T00:00:00.000Z');
    expect(healthy.status).toBe('healthy');
    expect(healthy.probes.map((probe) => probe.state)).toEqual(['healthy', 'healthy']);
    expect(healthy.checkedAt).toBe('2026-09-20T00:00:00.000Z');
  });

  it('marks the whole snapshot unavailable when readiness fails', () => {
    const degraded = buildSnapshot(200, 503, '2026-09-20T00:00:00.000Z');
    expect(degraded.status).toBe('unavailable');
    expect(degraded.probes.find((probe) => probe.id === 'ready')?.state).toBe('unavailable');
  });

  it('exposes no detail beyond the state word and the HTTP status', () => {
    const snapshot = buildSnapshot(200, 503, '2026-09-20T00:00:00.000Z');
    expect(Object.keys(snapshot).sort()).toEqual(['checkedAt', 'probes', 'status']);
    for (const probe of snapshot.probes) {
      expect(Object.keys(probe).sort()).toEqual(['id', 'label', 'state', 'status']);
    }
    // A sanitized report can never carry a stack trace, connection string or body.
    expect(JSON.stringify(snapshot)).not.toMatch(/postgres|password|at Object|stack/i);
  });
});
