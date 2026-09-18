import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@slate/observability';

import { MediaEngine } from './engine';
import { FileSystemStorageProvider } from './providers/filesystem';
import {
  S3StorageProvider,
  type S3BodyLike,
  type S3ClientLike,
  type S3Command,
} from './providers/s3';
import type { MediaStorageProvider } from './types';

/**
 * `@slate/media` against both storage providers (ADR 006, "Validation").
 *
 * The provider seam is what a host swaps for AWS S3 / MinIO / a local disk, so
 * the suite runs the *same* assertions through each one and then checks the
 * claims only a real backend can satisfy: a presigned URL is time-bound, and a
 * file uploaded by one tenant can never be read, deleted or signed by another.
 *
 * The S3 backend is an in-memory fake rather than a live bucket: the contract
 * under test is `S3ClientLike`, and no CI run should need cloud credentials.
 */
class FakeS3Client implements S3ClientLike {
  private readonly objects = new Map<string, Buffer>();
  /** Keys the provider asked to delete, in order. */
  readonly deleted: string[] = [];
  /** Keys that answer `AccessDenied`; a 404 must never hide a denial. */
  readonly denied = new Set<string>();

  async send(command: S3Command): Promise<{ Body?: S3BodyLike | undefined }> {
    if (this.denied.has(command.Key)) {
      throw Object.assign(new Error('Access denied'), { name: 'AccessDenied' });
    }
    if (command.Method === 'PUT') {
      this.objects.set(command.Key, command.Body ?? Buffer.alloc(0));
      return {};
    }
    if (command.Method === 'DELETE') {
      this.deleted.push(command.Key);
      this.objects.delete(command.Key);
      return {};
    }
    const stored = this.objects.get(command.Key);
    if (stored === undefined) {
      throw Object.assign(new Error('Not found'), { name: 'NotFound' });
    }
    if (command.Method === 'HEAD') return {};
    return { Body: { toArray: async () => [stored] } };
  }
}

const root = mkdtempSync(join(tmpdir(), 'slate-media-it-'));
const logger = createLogger({ env: { SLATE_ENV: 'test' }, sink: vi.fn() });
const s3 = new FakeS3Client();
const credentials = {
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  region: 'eu-central-1',
  endpoint: 'minio.test',
  bucket: 'slate-media',
};
const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';

/** One engine per backend, both reached through the identical interface. */
const PROVIDERS = ['filesystem', 's3'] as const;
type ProviderKind = (typeof PROVIDERS)[number];

function providerFor(kind: ProviderKind): MediaStorageProvider {
  return kind === 'filesystem'
    ? new FileSystemStorageProvider(root)
    : new S3StorageProvider(s3, credentials);
}

function engineFor(kind: ProviderKind): MediaEngine {
  return new MediaEngine(providerFor(kind), logger);
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('@slate/media (integration)', () => {
  describe.each(PROVIDERS)('%s backend', (kind) => {
    it('round-trips an object under the tenant prefix', async () => {
      const engine = engineFor(kind);
      const content = Buffer.from(`${kind}-payload`);
      const meta = await engine.uploadFile(tenantA, 'avatars', 'me.png', content, 'image/png');

      expect(meta).toEqual({
        path: `storage/${tenantA}/avatars/me.png`,
        size: content.length,
        mimeType: 'image/png',
      });
      expect(await engine.exists(tenantA, meta.path)).toBe(true);
      expect(await engine.downloadFile(tenantA, meta.path)).toEqual(content);
      expect(await engine.exists(tenantA, `storage/${tenantA}/avatars/missing.png`)).toBe(false);
    });

    it('keeps an object unreachable from any other tenant', async () => {
      const engine = engineFor(kind);
      const meta = await engine.uploadFile(
        tenantA,
        'docs',
        'contract.pdf',
        Buffer.from('secret'),
        'application/pdf',
      );

      // Every tenant-bound entry point refuses the foreign tenant, and refuses
      // *before* the provider runs, so no signature or stored object leaks.
      await expect(engine.downloadFile(tenantB, meta.path)).rejects.toThrow(
        'Tenant isolation violation',
      );
      await expect(engine.deleteFile(tenantB, meta.path)).rejects.toThrow(
        'Tenant isolation violation',
      );
      await expect(engine.getDownloadUrl(tenantB, meta.path)).rejects.toThrow(
        'Tenant isolation violation',
      );
      await expect(engine.exists(tenantB, meta.path)).rejects.toThrow('Tenant isolation violation');

      // A rejected cross-tenant call leaves the owner's object untouched.
      expect(await engine.downloadFile(tenantA, meta.path)).toEqual(Buffer.from('secret'));
    });

    it('generates a time-bound URL for the owner of the object', async () => {
      const engine = engineFor(kind);
      const { path, url } = await engine.getUploadUrl(tenantA, 'docs', 'resume.pdf', 900);
      expect(path).toBe(`storage/${tenantA}/docs/resume.pdf`);
      expect(url.startsWith('storage')).toBe(false);

      const download = await engine.getDownloadUrl(tenantA, path, 60);
      if (kind === 's3') {
        expect(download).toContain(path);
        expect(new URL(download).searchParams.get('X-Amz-Expires')).toBe('60');
      } else {
        expect(download.startsWith('file://')).toBe(true);
        // The local backend serves the very key it stored (Windows separators).
        expect(download.replace(/\\/g, '/')).toContain(path);
      }
    });
  });

  describe('S3StorageProvider', () => {
    it('signs each operation and window separately, so a URL is time-bound', async () => {
      const provider = providerFor('s3') as S3StorageProvider;
      const path = `storage/${tenantA}/docs/a.pdf`;
      const shortLived = await provider.getSignedUrl(path, 30);
      const longerLived = await provider.getSignedUrl(path, 900);
      const upload = await provider.getUploadUrl(path, 30);

      expect(shortLived).not.toBe(upload); // a download URL is not an upload URL
      expect(shortLived).not.toBe(longerLived); // the deadline is part of the signature
      expect(new URL(longerLived).searchParams.get('X-Amz-Expires')).toBe('900');
    });

    it('tells a missing object apart from a denied one', async () => {
      const provider = providerFor('s3') as S3StorageProvider;
      expect(await provider.exists(`storage/${tenantA}/docs/never-written.pdf`)).toBe(false);

      // An authorization failure must surface, not read as "file absent".
      const denied = `storage/${tenantA}/docs/denied.pdf`;
      s3.denied.add(denied);
      await expect(provider.exists(denied)).rejects.toThrow('Access denied');
    });

    it('deletes the object it was asked to delete', async () => {
      const engine = engineFor('s3');
      const meta = await engine.uploadFile(
        tenantA,
        'docs',
        'temp.txt',
        Buffer.from('x'),
        'text/plain',
      );
      expect(await engine.exists(tenantA, meta.path)).toBe(true);

      await engine.deleteFile(tenantA, meta.path);
      expect(s3.deleted).toContain(meta.path);
      expect(await engine.exists(tenantA, meta.path)).toBe(false);
    });
  });
});
