import { OfcaContainerSchema, OfcaManifestSchema, stripReservedOfcaLabels } from './docker-container-archive-format.js';
export const dockerArchiveCommercialRuntime = { OfcaContainerSchema, OfcaManifestSchema, stripReservedOfcaLabels };

export type DockerArchiveOperations = Pick<
  typeof import('./docker-container-archive.js'),
  'openOfcaExport' | 'importOfca'
>;
