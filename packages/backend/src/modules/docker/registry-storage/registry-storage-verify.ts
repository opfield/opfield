import type { DockerRegistryMaintenanceStore } from '../docker-registry-maintenance.js';
import { selectRegistryRetentionCandidates } from '../docker-registry-retention.js';
import type { DockerRegistryGrant, DockerRegistryTokenService } from '../docker-registry-token.service.js';

/** Images the storage switch checks on the new storage: the ones workloads run and roll back to. */
export interface RegistryImageRef {
  repository: string;
  digest: string;
}

const MAX_CHECKED = 2000;
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

/**
 * The images the registry keeps for workloads that it serves now: every build a container, deployment or Compose
 * service runs, the build each keeps to roll back to, and the pinned ones (Availability mirrors, promoted copies,
 * builds in flight); those must survive the switch. Running ones first, at most MAX_CHECKED.
 */
export async function readableImagesInUse(
  store: DockerRegistryMaintenanceStore,
  tokenService: DockerRegistryTokenService,
  registryUrl: string
): Promise<RegistryImageRef[]> {
  const { retained } = selectRegistryRetentionCandidates(await store.listRetentionArtifacts(new Date()));
  const rank = (artifact: (typeof retained)[number]) => (artifact.running ? 0 : artifact.pinned ? 1 : 2);
  const seen = new Set<string>();
  const kept: RegistryImageRef[] = [];
  for (const artifact of [...retained].sort((left, right) => rank(left) - rank(right))) {
    const key = `${artifact.repository}@${artifact.digest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ repository: artifact.repository, digest: artifact.digest });
    if (kept.length >= MAX_CHECKED) break;
  }
  const readable: RegistryImageRef[] = [];
  for (const image of kept) {
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
