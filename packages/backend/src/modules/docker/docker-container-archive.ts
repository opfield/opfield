import type { OfcaContainerManifest, OfcaImportResolution, OfcaManifest } from './docker-container-archive-format.js';
import type { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';

export type { OfcaContainerManifest, OfcaImportResolution, OfcaManifest } from './docker-container-archive-format.js';

interface OfcaFooter {
  algorithm: 'sha256';
  manifestDigest: string;
  imageDigest: string;
  imageBytes: number;
}
export declare function openOfcaExport(args: {
  dispatch: DockerMigrationDispatchAdapter;
  nodeId: string;
  containerId: string;
  includeWritableLayer: boolean;
  imageMode: 'portable' | 'registry';
  environment: Record<string, string>;
  secrets?: Record<string, string>;
  secretKeys?: string[];
  includeEnvironment?: boolean;
  includeSecrets?: boolean;
}): Promise<{
  archiveId: string;
  filename: string;
  stream: ReadableStream<Uint8Array>;
}>;
export declare class OfcaImportReader {
  private bytes;
  footer: OfcaFooter | null;
  private hasher;
  private imageBytes;
  private manifestDigest;
  constructor(stream: ReadableStream<Uint8Array>);
  private readFrame;
  readManifest(): Promise<OfcaManifest>;
  imageChunks(): AsyncGenerator<Uint8Array>;
}
export declare function importOfca(args: {
  dispatch: DockerMigrationDispatchAdapter;
  nodeId: string;
  name: string;
  body: ReadableStream<Uint8Array>;
  resolution?: OfcaImportResolution;
  authorizeContents?: (container: OfcaContainerManifest) => void | Promise<void>;
  resolveRegistryAuthCandidates?: (imageReference: string) => Promise<string[]>;
}): Promise<{
  archiveId: string;
  containerId: string;
  containerName: string;
  imageId: string;
  environment: Record<string, string>;
  secrets: Record<string, string>;
  createdVolumes: string[];
}>;
export declare function ofcaPortKey(port: { containerPort: number; hostPort: number; protocol: string }): string;
export declare function applyOfcaImportResolution(manifest: OfcaManifest, resolution: OfcaImportResolution): void;
