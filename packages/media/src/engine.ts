import type { Logger } from '@slate/observability';
import type { MediaStorageProvider, StorageMetadata } from './types';
import { getTenantPath, assertTenantBound } from './paths';

export class MediaEngine {
  constructor(
    private readonly provider: MediaStorageProvider,
    private readonly logger: Logger,
  ) {}

  async uploadFile(
    tenantId: string,
    category: string,
    fileName: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<StorageMetadata> {
    const path = getTenantPath(tenantId, category, fileName);
    this.logger.debug('uploading media file', { tenantId, path });
    return this.provider.upload(path, buffer, mimeType);
  }

  async downloadFile(tenantId: string, path: string): Promise<Buffer> {
    assertTenantBound(tenantId, path);
    return this.provider.download(path);
  }

  async getDownloadUrl(tenantId: string, path: string, expiresIn = 3600): Promise<string> {
    assertTenantBound(tenantId, path);
    return this.provider.getSignedUrl(path, expiresIn);
  }

  async getUploadUrl(
    tenantId: string,
    category: string,
    fileName: string,
    expiresIn = 3600,
  ): Promise<{ path: string; url: string }> {
    const path = getTenantPath(tenantId, category, fileName);
    const url = await this.provider.getUploadUrl(path, expiresIn);
    return { path, url };
  }

  async deleteFile(tenantId: string, path: string): Promise<void> {
    assertTenantBound(tenantId, path);
    await this.provider.delete(path);
  }

  async exists(tenantId: string, path: string): Promise<boolean> {
    assertTenantBound(tenantId, path);
    return this.provider.exists(path);
  }

  getProvider(): MediaStorageProvider {
    return this.provider;
  }
}
