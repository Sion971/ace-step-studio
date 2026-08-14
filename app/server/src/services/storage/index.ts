export interface StorageProvider {
  upload(key: string, data: Buffer, contentType: string): Promise<string>;
  getUrl(key: string, expiresIn?: number): Promise<string>;
  getPublicUrl(key: string): string;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  copy(sourceKey: string, destKey: string): Promise<void>;
  /** Optional: read a stored object back into memory. Implemented by
   *  LocalStorageProvider; remote providers (S3 etc.) may omit it to
   *  signal callers that an in-memory round-trip is too expensive there. */
  read?(key: string): Promise<Buffer>;
}

export type { StorageProvider as default };
