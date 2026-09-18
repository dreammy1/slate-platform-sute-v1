export interface StorageMetadata {
  readonly path: string;
  readonly size: number;
  readonly mimeType: string;
}

export interface MediaStorageProvider {
  upload(path: string, buffer: Buffer, mimeType: string): Promise<StorageMetadata>;
  download(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  getSignedUrl(path: string, expiresIn: number): Promise<string>;
  getUploadUrl(path: string, expiresIn: number): Promise<string>;
  exists(path: string): Promise<boolean>;
}
