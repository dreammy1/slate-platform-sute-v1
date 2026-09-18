import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import type { MediaStorageProvider, StorageMetadata } from '../types';

export class FileSystemStorageProvider implements MediaStorageProvider {
  constructor(private readonly rootDir: string) {}

  private getAbsolutePath(path: string) {
    return join(this.rootDir, path);
  }

  async upload(path: string, buffer: Buffer, mimeType: string): Promise<StorageMetadata> {
    const absolutePath = this.getAbsolutePath(path);
    await fs.mkdir(dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);

    return {
      path,
      size: buffer.length,
      mimeType,
    };
  }

  async download(path: string): Promise<Buffer> {
    return fs.readFile(this.getAbsolutePath(path));
  }

  async delete(path: string): Promise<void> {
    await fs.unlink(this.getAbsolutePath(path));
  }

  async getSignedUrl(path: string, _expiresIn: number): Promise<string> {
    // For local FS, we just return the path.
    // expiresIn is ignored as local files are permanent unless deleted.
    return `file://${this.getAbsolutePath(path)}`;
  }

  async getUploadUrl(path: string, expiresIn: number): Promise<string> {
    // Local FS allows PUTs via the same "URL" (path) for simplicity in dev.
    return this.getSignedUrl(path, expiresIn);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(this.getAbsolutePath(path));
      return true;
    } catch {
      return false;
    }
  }
}
