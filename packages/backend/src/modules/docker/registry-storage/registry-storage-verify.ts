import type { DockerRegistryMaintenanceStore } from '../docker-registry-maintenance.js';
import type { DockerRegistryGrant, DockerRegistryTokenService } from '../docker-registry-token.service.js';

/** Images the storage switch checks on the new storage: the ones running workloads and rollbacks use. */
export interface RegistryImageRef {
  repository: string;
  digest: string;
}

const MAX_CHECKED = 500;
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

async function manifestStatus(
  tokenService: DockerRegistryTokenService,
  registryUrl: string,
  image: RegistryImageRef
): Promise<number> {
  const grant = { repository: image.repository, actions: ['pull'] } satisfies DockerRegistryGrant;
  const { token } = tokenService.issueToken({
    subject: 'opfield:registry-storage',
    requested: [grant],
    allowed: [grant],
    ttlSeconds: 300,
  });
  const repository = image.repository.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(
    new URL(`/v2/${repository}/manifests/${encodeURIComponent(image.digest)}`, registryUrl),
    {
      method: 'HEAD',
      headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(30_000),
    }
  );
  await response.body?.cancel();
  return response.status;
}

/** The pinned images (in use by workloads) the registry serves now; only those must survive the switch. */
export async function readablePinnedImages(
  store: DockerRegistryMaintenanceStore,
  tokenService: DockerRegistryTokenService,
  registryUrl: string
): Promise<RegistryImageRef[]> {
  const seen = new Set<string>();
  const pinned: RegistryImageRef[] = [];
  for (const artifact of await store.listRetentionArtifacts(new Date())) {
    const key = `${artifact.repository}@${artifact.digest}`;
    if (!artifact.pinned || seen.has(key)) continue;
    seen.add(key);
    pinned.push({ repository: artifact.repository, digest: artifact.digest });
    if (pinned.length >= MAX_CHECKED) break;
  }
  const readable: RegistryImageRef[] = [];
  for (const image of pinned) {
    if ((await manifestStatus(tokenService, registryUrl, image).catch(() => 0)) === 200) readable.push(image);
  }
  return readable;
}

export async function verifyImagesReadable(
  images: readonly RegistryImageRef[],
  tokenService: DockerRegistryTokenService,
  registryUrl: string
): Promise<void> {
  for (const image of images) {
    const status = await manifestStatus(tokenService, registryUrl, image).catch(() => 0);
    if (status !== 200) {
      throw new Error(
        `${image.repository}@${image.digest} is not readable on the new storage (${status || 'no answer'})`
      );
    }
  }
}
