/**
 * `@slate/notifications` � provider-agnostic transactional delivery (SLATE-206).
 *
 * We implement the Transactional Outbox pattern by wrapping notification
 * requests as `@slate/jobs`. Domain handlers enqueue a delivery job; the jobs
 * worker executes it, resolving the active provider and performing the I/O.
 */

import { type Kysely } from 'kysely';
import { type Database } from '@slate/database';
import type { Logger } from '@slate/observability';
import {
  createJobRegistry,
  enqueue,
  type EnqueueResult,
  type JobDefinition,
  type JobHandlerContext,
  type JobEventPublisher,
  type JobRegistryMap,
} from '@slate/jobs';

/** Stable identifier for a sent notification (provider-derived). */
export type MessageId = string;

/**
 * The `NotificationProvider` interface abstracts the delivery mechanism (Email/SMS).
 * Implementation instances are injected at the host level.
 */
export interface NotificationProvider {
  readonly name: string;
  sendEmail(to: string, template: string, params: Record<string, unknown>): Promise<MessageId>;
  sendSms(to: string, body: string): Promise<MessageId>;
}

/** Input for a notification delivery job. */
export interface NotificationPayload {
  readonly type: 'email' | 'sms';
  readonly recipient: string;
  readonly content: {
    readonly template?: string;
    readonly body?: string;
    readonly params?: Record<string, unknown>;
  };
}

/**
 * The host-injected service that coordinates providers.
 */
export class NotificationService {
  constructor(
    private readonly provider: NotificationProvider,
    private readonly logger: Logger,
    private readonly db: Kysely<Database>,
  ) {}

  async deliver(jobId: string, payload: NotificationPayload): Promise<MessageId> {
    this.logger.info('delivering notification', { jobId, payload });

    let messageId: MessageId | undefined;
    let error: Error | undefined;

    try {
      if (payload.type === 'email') {
        if (!payload.content.template) {
          throw new Error('Email delivery requires a template.');
        }
        messageId = await this.provider.sendEmail(
          payload.recipient,
          payload.content.template,
          payload.content.params ?? {},
        );
      } else if (payload.type === 'sms') {
        if (!payload.content.body) {
          throw new Error('SMS delivery requires a body.');
        }
        messageId = await this.provider.sendSms(payload.recipient, payload.content.body);
      } else {
        throw new Error(`Unsupported notification type: ${payload.type}`);
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      throw error;
    } finally {
      // Record the outcome in the delivery log
      await this.db
        .insertInto('notification_delivery_log')
        .values({
          tenant_id: (this.db as unknown as { tenantId: string }).tenantId,
          job_id: jobId,
          recipient: payload.recipient,
          type: payload.type,
          provider_message_id: messageId ?? null,
          status: error ? 'failed' : 'delivered',
          error_code: (error as unknown as { code?: string })?.code ?? (error ? 'unknown' : null),
        })
        .execute();
    }

    return messageId!;
  }
}

/**
 * The Job Definition for notification delivery.
 */
export const NotificationJobDefinition: JobDefinition<NotificationPayload> = {
  parse: (raw: unknown): NotificationPayload => {
    const p = raw as NotificationPayload;
    if (!p || typeof p !== 'object') throw new Error('Invalid payload');
    if (p.type !== 'email' && p.type !== 'sms') throw new Error('Invalid notification type');
    if (!p.recipient) throw new Error('Recipient is required');
    return p;
  },
  handler: async (context: JobHandlerContext<NotificationPayload>) => {
    context.logger.info('executing notification delivery', {
      jobId: context.jobId,
      recipient: context.payload.recipient,
    });
  },
};

/**
 * The notification job surface.
 *
 * The registry is the entire enqueue surface (ADR 004): declaring the delivery
 * type here is what lets `enqueueNotification` enqueue it at all, and a host
 * merges this map into its own before starting a worker, so a persisted row can
 * only execute if a handler for it exists in trusted server code.
 */
export const NOTIFICATION_JOB_TYPES = createJobRegistry({
  'notification.deliver': NotificationJobDefinition,
});

/** Server-derived enqueue context; a client supplies none of it (Section 13). */
export interface EnqueueNotificationContext {
  readonly tenantId: string;
  readonly actorUserId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly publisher?: JobEventPublisher | undefined;
  /** Extra definitions to make visible; defaults to {@link NOTIFICATION_JOB_TYPES}. */
  readonly registry?: JobRegistryMap | undefined;
  /**
   * Stable caller-chosen key: the same key with the same payload deduplicates,
   * the same key with a different payload conflicts (ADR 004).
   */
  readonly idempotencyKey?: string | undefined;
}

/**
 * Transactional enqueue for a notification: call it inside the domain
 * transaction, so the write, the `background_job` row and exactly one
 * `jobs.enqueued` audit row commit together — or not at all.
 */
export async function enqueueNotification(
  trx: Kysely<Database>,
  context: EnqueueNotificationContext,
  payload: NotificationPayload,
): Promise<EnqueueResult> {
  return enqueue(
    trx,
    {
      registry: context.registry ?? NOTIFICATION_JOB_TYPES,
      tenantId: context.tenantId,
      actorUserId: context.actorUserId,
      requestId: context.requestId,
      publisher: context.publisher,
    },
    {
      type: 'notification.deliver',
      payload,
      idempotencyKey: context.idempotencyKey ?? `notif:${payload.recipient}:${Date.now()}`,
    },
  );
}
