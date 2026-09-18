import { createHmac } from 'node:crypto';
import type { MediaStorageProvider, StorageMetadata } from '../types';

/** The subset of an S3 `GetObject` response body this provider reads. */
export interface S3BodyLike {
  toArray(): Promise<Uint8Array[]>;
}

/** The S3 operation a command stands for; an adapter routes/translates on it. */
export type S3Operation = 'PUT' | 'GET' | 'DELETE' | 'HEAD';

/** One S3-compatible request, described independently of the AWS SDK. */
export interface S3Command {
  readonly Bucket: string;
  readonly Key: string;
  readonly Method: S3Operation;
  readonly Body?: Buffer | undefined;
  readonly ContentType?: string | undefined;
}

/** The S3 seam: a host supplies an SDK-backed client, tests a fake one. */
export interface S3ClientLike {
  send(command: S3Command): Promise<{ Body?: S3BodyLike | undefined }>;
}

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly bucket: string;
}

/**
 * Recognises the "object does not exist" answers of S3-compatible services.
 *
 * The SDK reports them as an error `name` while raw HTTP answers carry a status
 * code, so both shapes are checked and anything else is rethrown: an access
 * denial must never be reported as "file missing".
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; status?: unknown; statusCode?: unknown };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.status === 404 ||
    candidate.statusCode === 404
  );
}

export class S3StorageProvider implements MediaStorageProvider {
  constructor(
    private readonly client: S3ClientLike,
    private readonly creds: S3Credentials,
  ) {}

  async upload(path: string, buffer: Buffer, mimeType: string): Promise<StorageMetadata> {
    // The host-provided client handles the PutObject call.
    await this.client.send({
      Bucket: this.creds.bucket,
      Key: path,
      Method: 'PUT',
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
      Method: 'GET',
    });
    // A response without a body is not a download; fail loudly instead of
    // returning an empty buffer that a caller would mistake for an empty file.
    if (response.Body === undefined) throw new Error('S3 object body is missing');
    return Buffer.concat(await response.Body.toArray());
  }

  async delete(path: string): Promise<void> {
    await this.client.send({
      Bucket: this.creds.bucket,
      Key: path,
      Method: 'DELETE',
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
        Method: 'HEAD',
      });
      return true;
    } catch (error: unknown) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private sign(path: string, method: 'GET' | 'PUT', expiresIn: number): string {
    // A simplified SigV4-like signing for local verification.
    // In production, this uses the actual SDK's getSignedUrl.
    //
    // `expiresIn` is advertised as the duration (`X-Amz-Expires`, as S3 expects)
    // while the *absolute* deadline it resolves to is what the signature covers,
    // so a URL is bound to the moment it was issued and cannot be re-dated.
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const stringToSign = `${method}\n${this.creds.region}\n${this.creds.bucket}\n${path}\n${expiresAt}`;
    const signature = createHmac('sha256', this.creds.secretAccessKey)
      .update(stringToSign)
      .digest('hex');

    const host = this.creds.endpoint ?? `s3.${this.creds.region}.amazonaws.com`;
    return `https://${this.creds.bucket}.${host}/${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=${expiresIn}&X-Amz-Signature=${signature}`;
  }
}
