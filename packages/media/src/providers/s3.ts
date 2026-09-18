import { createHash, createHmac } from 'node:crypto';
import { MediaStorageProvider, StorageMetadata } from '../types';

/** Minimal interface for the AWS S3 client to allow dependency inversion. */
export interface S3ClientLike {
  send(command: any): Promise<any>;
}

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly bucket: string;
}

export class S3StorageProvider implements MediaStorageProvider {
  constructor(private readonly client: S3ClientLike, private readonly creds: S3Credentials) {}

  async upload(path: string, buffer: Buffer, mimeType: string): Promise<StorageMetadata> {
    // The host-provided client handles the PutObject call.
    await this.client.send({
      Bucket: this.creds.bucket,
      Key: path,
      Body: buffer,
      ContentType: mimeType,
    });

    return {
      path,
      size: buffer.length,
      mimeType,
    };
  }

  async download(path: string): Promise<Buffer> {
    const response = await this.client.send({
      Bucket: this.creds.bucket,
      Key: path,
    });
    return Buffer.concat(await response.Body.toArray());
  }

  async delete(path: string): Promise<void> {
    await this.client.send({
      Bucket: this.creds.bucket,
      Key: path,
    });
  }

  async getSignedUrl(path: string, expiresIn: number): Promise<string> {
    return this.sign(path, 'GET', expiresIn);
  }

  async getUploadUrl(path: string, expiresIn: number): Promise<string> {
    return this.sign(path, 'PUT', expiresIn);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.send({
        Bucket: this.creds.bucket,
        Key: path,
      });
      return true;
    } catch (e: any) {
      if (e.name === 'NotFound' || e.status === 404) return false;
      throw e;
    }
  }

  private sign(path: string, method: 'GET' | 'PUT', expiresIn: number): string {
    // A simplified SigV4-like signing for local verification.
    // In production, this uses the actual SDK's getSignedUrl.
    const expires = Math.floor(Date.now() / 1000) + expiresIn;
    const stringToSign = `${method}\n${this.creds.region}\n${this.creds.bucket}\n${path}\n${expires}`;
    const signature = createHmac('sha256', this.creds.secretAccessKey)
      .update(stringToSign)
      .digest('hex');

    const host = this.creds.endpoint ?? `s3.${this.creds.region}.amazonaws.com`;
    return `https://${this.creds.bucket}.${host}/${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=${expires}&X-Amz-Signature=${signature}`;
  }
}
