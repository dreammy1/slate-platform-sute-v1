import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { MediaEngine } from './engine';
import { FileSystemStorageProvider } from './providers/filesystem';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@slate/observability';

describe('MediaEngine', () => {
  let engine: MediaEngine;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `slate-media-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const provider = new FileSystemStorageProvider(testDir);
    const logger = createLogger({ env: { SLATE_ENV: 'test' }, sink: vi.fn() });
    engine = new MediaEngine(provider, logger);
  });

  it('uploads and downloads a file', async () => {
    const tenantId = 'tenant-1';
    const category = 'profiles';
    const fileName = 'avatar.png';
    const content = Buffer.from('fake-image-data');
    const mimeType = 'image/png';

    const meta = await engine.uploadFile(tenantId, category, fileName, content, mimeType);
    expect(meta.path).toBe(`storage/${tenantId}/${category}/${fileName}`);
    expect(meta.size).toBe(content.length);

    const downloaded = await engine.downloadFile(tenantId, meta.path);
    expect(downloaded).toEqual(content);
  });

  it('enforces tenant isolation on download', async () => {
    const tenantA = 'tenant-a';
    const tenantB = 'tenant-b';
    const path = `storage/${tenantA}/test.txt`;

    await engine.getProvider().upload(path, Buffer.from('secret'), 'text/plain');

    await expect(engine.downloadFile(tenantB, path)).rejects.toThrow('Tenant isolation violation');
  });

  it('enforces tenant isolation on delete', async () => {
    const tenantA = 'tenant-a';
    const tenantB = 'tenant-b';
    const path = `storage/${tenantA}/test.txt`;

    await engine.getProvider().upload(path, Buffer.from('secret'), 'text/plain');

    await expect(engine.deleteFile(tenantB, path)).rejects.toThrow('Tenant isolation violation');
  });

  it('generates a presigned upload URL', async () => {
    const tenantId = 'tenant-1';
    const { path, url } = await engine.getUploadUrl(tenantId, 'docs', 'resume.pdf');
    expect(path).toBe('storage/tenant-1/docs/resume.pdf');
    expect(url).toContain('file://');
  });

  it('correctly reports file existence', async () => {
    const tenantId = 'tenant-1';
    const path = 'storage/tenant-1/exists.txt';
    await engine.getProvider().upload(path, Buffer.from('ok'), 'text/plain');

    expect(await engine.exists(tenantId, path)).toBe(true);
    expect(await engine.exists(tenantId, 'storage/tenant-1/missing.txt')).toBe(false);
  });
});
