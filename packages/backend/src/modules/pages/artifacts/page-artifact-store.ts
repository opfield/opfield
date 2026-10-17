import os from 'node:os';
import { join } from 'node:path';

const PRODUCTION_STORAGE_DIR = '/var/lib/opfield/pages';

import { commercialModuleUnavailable } from '@/edition/unavailable.js';
export class PageArtifactStore {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_root: string) {}
  async initialize(): Promise<void> {}
  uploadKey(_uploadId: string): string {
    return commercialModuleUnavailable();
  }
  artifactKey(_projectId: string, _deploymentId: string): string {
    return commercialModuleUnavailable();
  }
  resolveKey(_key: string): string {
    return commercialModuleUnavailable();
  }
  async appendChunk(_key: string, _expectedOffset: number, _bytes: Uint8Array): Promise<number> {
    return commercialModuleUnavailable();
  }
  async rollbackChunk(_key: string, _expectedOffset: number, _writtenEndOffset: number): Promise<void> {
    return commercialModuleUnavailable();
  }
  async size(_key: string): Promise<number> {
    return commercialModuleUnavailable();
  }
  async sha256(_key: string): Promise<string> {
    return commercialModuleUnavailable();
  }
  read(_key: string): import('fs').ReadStream {
    return commercialModuleUnavailable();
  }
  async commitUpload(_uploadKey: string, _artifactKey: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async remove(_key: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async removeEmptyProjectDirs(): Promise<number> {
    return commercialModuleUnavailable();
  }
  async assertDiskAvailable(_incomingBytes: number): Promise<void> {
    return commercialModuleUnavailable();
  }
}

export function resolvePageStorageDir(
  configuredDirectory: string,
  nodeEnvironment: string | undefined,
  temporaryDirectory = os.tmpdir()
): string {
  if (nodeEnvironment === 'production' || configuredDirectory !== PRODUCTION_STORAGE_DIR) return configuredDirectory;
  return join(temporaryDirectory, 'opfield-pages');
}
