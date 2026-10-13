import type { Readable } from 'node:stream';
import type { StorageConnectionConfig } from './object-storage-connection-view.js';

export interface S3BucketInfo {
  name: string;
  creationDate: string | null;
}
export interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
}
export interface S3ObjectListing {
  prefixes: string[];
  objects: S3ObjectInfo[];
  nextContinuationToken: string | null;
  isTruncated: boolean;
}
export interface S3ObjectMetadata {
  contentType: string | null;
  contentLength: number;
  lastModified: string | null;
  etag: string | null;
  metadata: Record<string, string>;
}

export type StorageBackendFactory = (
  config: StorageConnectionConfig,
  options?: { internalCaPem?: string }
) => StorageBackend;

export interface ListObjectsParams {
  bucket: string;
  prefix?: string;
  delimiter?: string;
  continuationToken?: string;
  maxKeys?: number;
}

export interface UploadObjectParams {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array | Readable;
  contentType?: string;
}

export interface PresignParams {
  bucket: string;
  key: string;
  operation: 'get' | 'put';
  contentType?: string;
  expiresIn: number;
}

export interface ObjectStreamResult {
  body: Readable;
  contentType: string | null;
  contentLength: number | null;
}

/**
 * The storage operations the object browser and backup targets rely on,
 * independent of whether they are served over S3 or a file protocol.
 *
 * File protocols have no bucket namespace: implementations map the first path
 * segment under the connection's base path onto `bucket`, and everything below
 * it onto `key`. That keeps one API — and one UI — across both families.
 */
export interface StorageBackend {
  listBuckets(): Promise<S3BucketInfo[]>;
  createBucket(bucket: string): Promise<void>;
  deleteBucket(bucket: string): Promise<void>;
  listObjects(params: ListObjectsParams): Promise<S3ObjectListing>;
  headObject(bucket: string, key: string): Promise<S3ObjectMetadata>;
  /**
   * Returns a browser-fetchable URL, or null when the protocol has no such
   * concept. FTP and SFTP cannot mint capability URLs, so their callers fall
   * back to streaming the object through Opfield.
   */
  presignObject(params: PresignParams): Promise<string | null>;
  uploadObject(params: UploadObjectParams): Promise<void>;
  getObjectStream(bucket: string, key: string): Promise<ObjectStreamResult>;
  createPrefix(bucket: string, prefix: string): Promise<void>;
  deleteObjects(bucket: string, keys: string[]): Promise<void>;
  /** Cheap round-trip used by health probes and the "Test connection" action. */
  probe(): Promise<void>;
  destroy(): void;
}
