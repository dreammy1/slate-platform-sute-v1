import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueueNotification, NotificationJobDefinition } from '../index.ts';
import { type Kysely } from 'kysely';
import { type Database } from '@slate/database';

describe('Notifications Integration', () => {
  let trx: unknown;

  beforeEach(() => {
    trx = {
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflict: vi.fn().mockReturnValue({
            returning: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue({ id: 'job-123' }),
            }),
          }),
        }),
      }),
    };
  });

  it('enqueues a notification as a background job', async () => {
    const payload = {
      type: 'email' as const,
      recipient: 'user@example.com',
      content: { template: 'welcome' },
    };

    const result = await enqueueNotification(
      trx as unknown as Kysely<Database>,
      {
        tenantId: 'tenant-1',
      },
      payload,
    );

    expect(result.jobId).toBe('job-123');
    expect(result.created).toBe(true);
  });

  it('validates notification payloads via the job definition', () => {
    const validPayload = {
      type: 'email',
      recipient: 'user@example.com',
      content: { template: 'welcome' },
    };
    expect(NotificationJobDefinition.parse(validPayload)).toEqual(validPayload);

    const invalidPayload = {
      type: 'invalid',
      recipient: 'user@example.com',
      content: {},
    };
    expect(() => NotificationJobDefinition.parse(invalidPayload)).toThrow(
      'Invalid notification type',
    );
  });
});
