import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NotificationService,
  type NotificationProvider,
  type NotificationPayload,
} from '../index.ts';
import type { Logger } from '@slate/observability';
import { type Kysely } from 'kysely';
import { type Database } from '@slate/database';

interface MockDb {
  insertInto: unknown;
  tenantId: string;
}

describe('NotificationService', () => {
  let mockProvider: NotificationProvider;
  let mockLogger: Logger;
  let mockDb: MockDb;
  let service: NotificationService;

  beforeEach(() => {
    mockProvider = {
      name: 'mock-provider',
      sendEmail: vi.fn().mockResolvedValue('msg-123'),
      sendSms: vi.fn().mockResolvedValue('sms-123'),
    };
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    mockDb = {
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue([{}]),
        }),
      }),
      tenantId: 'tenant-1',
    };
    service = new NotificationService(
      mockProvider,
      mockLogger,
      mockDb as unknown as Kysely<Database>,
    );
  });

  it('delivers an email and logs the result', async () => {
    const payload: NotificationPayload = {
      type: 'email',
      recipient: 'user@example.com',
      content: { template: 'welcome', params: { name: 'Alice' } },
    };

    const msgId = await service.deliver('job-1', payload);

    expect(msgId).toBe('msg-123');
    expect(mockProvider.sendEmail).toHaveBeenCalledWith('user@example.com', 'welcome', {
      name: 'Alice',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb.insertInto as any).mock.calls[0][0]).toBe('notification_delivery_log');
  });

  it('delivers an SMS and logs the result', async () => {
    const payload: NotificationPayload = {
      type: 'sms',
      recipient: '+123456789',
      content: { body: 'Hello!' },
    };

    const msgId = await service.deliver('job-2', payload);

    expect(msgId).toBe('sms-123');
    expect(mockProvider.sendSms).toHaveBeenCalledWith('+123456789', 'Hello!');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb.insertInto as any).mock.calls[0][0]).toBe('notification_delivery_log');
  });

  it('logs a failure when the provider throws', async () => {
    const payload: NotificationPayload = {
      type: 'email',
      recipient: 'user@example.com',
      content: { template: 'welcome' },
    };
    const error = new Error('Provider Down');
    (error as unknown as { code?: string }).code = 'PROVIDER_ERROR';
    mockProvider.sendEmail = vi.fn().mockRejectedValue(error);

    await expect(service.deliver('job-3', payload)).rejects.toThrow('Provider Down');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb.insertInto as any).mock.calls[0][0]).toBe('notification_delivery_log');
  });

  it('throws error for invalid payload', async () => {
    const payload: NotificationPayload = {
      type: 'email',
      recipient: 'user@example.com',
      content: {}, // missing template
    };

    await expect(service.deliver('job-4', payload)).rejects.toThrow(
      'Email delivery requires a template.',
    );
  });
});
