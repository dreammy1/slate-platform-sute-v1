import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NotificationService,
  type NotificationProvider,
  type NotificationPayload,
} from '../index.ts';
import type { Logger } from '@slate/observability';

describe('NotificationService', () => {
  let mockProvider: NotificationProvider;
  let mockLogger: Logger;
  let mockDb: any;
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
    } as any;
    mockDb = {
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue([{}]),
        }),
      }),
      tenantId: 'tenant-1',
    };
    service = new NotificationService(mockProvider, mockLogger, mockDb as any);
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
    expect(mockDb.insertInto).toHaveBeenCalledWith('notification_delivery_log');
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
    expect(mockDb.insertInto).toHaveBeenCalledWith('notification_delivery_log');
  });

  it('logs a failure when the provider throws', async () => {
    const payload: NotificationPayload = {
      type: 'email',
      recipient: 'user@example.com',
      content: { template: 'welcome' },
    };
    const error = new Error('Provider Down');
    (error as any).code = 'PROVIDER_ERROR';
    mockProvider.sendEmail = vi.fn().mockRejectedValue(error);

    await expect(service.deliver('job-3', payload)).rejects.toThrow('Provider Down');
    expect(mockDb.insertInto).toHaveBeenCalledWith('notification_delivery_log');
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
