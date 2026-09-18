import type { JobEventPublisher } from '@slate/jobs';

import type { Logger } from '@slate/observability';

export interface CoreEvents {
  'app.user.created': { tenantId: string; userId: string; actorUserId: string };
  'app.audit.recorded': { tenantId: string; auditId: string; actorUserId: string };
  /**
   * A tenant setting was written (SLATE-204). Carries the **key only**: a setting
   * may hold sensitive tenant data, and Section 61 forbids putting sensitive
   * customer data in events.
   */
  'settings.updated': { tenantId: string; key: string; actorUserId: string };
  /**
   * A tenant feature flag override was written or cleared (SLATE-204). Carries
   * the **key only**; consumers resolve the flag server-side rather than
   * trusting a value carried on the bus.
   */
  'feature.flag.updated': { tenantId: string; key: string; actorUserId: string };
  /**
   * Job lifecycle events (SLATE-204, ADR 004), bridged from `@slate/jobs` by
   * the host. Metadata only: `{ tenantId, jobId, type, attempt }` — never the
   * payload, which may hold sensitive tenant data (Section 61).
   */
  'jobs.enqueued': { tenantId: string; jobId: string; type: string; attempt: number };
  'jobs.succeeded': { tenantId: string; jobId: string; type: string; attempt: number };
  'jobs.failed': { tenantId: string; jobId: string; type: string; attempt: number };
  'jobs.retry_scheduled': { tenantId: string; jobId: string; type: string; attempt: number };
}
type Listener<K extends keyof CoreEvents> = (
  payload: Readonly<CoreEvents[K]>,
) => void | Promise<void>;

/** Best-effort in-process delivery, not a durable outbox. Subscribers cannot undo a commit. */
export function createEventBus(logger: Logger) {
  const listeners = new Map<keyof CoreEvents, Set<(payload: never) => void | Promise<void>>>();
  return {
    subscribe<K extends keyof CoreEvents>(name: K, listener: Listener<K>): () => void {
      const group = listeners.get(name) ?? new Set();
      group.add(listener);
      listeners.set(name, group);
      return () => {
        group.delete(listener);
      };
    },
    async publish<K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]): Promise<void> {
      for (const listener of [...(listeners.get(name) ?? [])]) {
        try {
          await listener(Object.freeze({ ...payload }) as never);
        } catch {
          // Never expose subscriber errors or turn a committed write into an HTTP failure.
          try {
            logger.error('event subscriber failed', { event: name });
          } catch {
            /* sink failure */
          }
        }
      }
    },
  };
}
export type EventBus = ReturnType<typeof createEventBus>;

/**
 * Bridges `@slate/jobs` lifecycle events onto this bus (ADR 004): the host
 * passes the returned adapter as the worker/enqueue publisher. Payloads are
 * already metadata-only; publishing stays best-effort exactly like every other
 * subscriber (a failed bridge listener never changes job state).
 */
export function bridgeJobEvents(events: EventBus): JobEventPublisher {
  return {
    publish(event, payload) {
      void events.publish(event, payload);
    },
  };
}
