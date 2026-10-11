import { OFFICIAL_IMAGE_REPOSITORIES } from '@/config/vendor-urls.js';

export type GatewayInternalImageKind =
  | 'secure-link-connector'
  | 'database-connector'
  | 'compose-sidecar'
  | 'build-artifact';

type DockerImageLike = Record<string, any>;

export interface GatewayInternalImageCandidate {
  id: string;
  kind: Exclude<GatewayInternalImageKind, 'compose-sidecar'>;
  repository: string;
  references: string[];
  created: number;
  size: number;
}

export function dockerImageReferences(image: DockerImageLike): string[] {
  const tags = image.repoTags ?? image.RepoTags;
  const digests = image.repoDigests ?? image.RepoDigests;
  return [...(Array.isArray(tags) ? tags : []), ...(Array.isArray(digests) ? digests : [])].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
}

export function dockerImageRepository(reference: string): string {
  const withoutDigest = reference.split('@', 1)[0]!;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

function normalizedRepository(reference: string): string {
  return dockerImageRepository(reference).replace(/^index\.docker\.io\//, 'docker.io/');
}

function normalizedReference(reference: string): string {
  return reference.replace(/^index\.docker\.io\//, 'docker.io/');
}

/** Whether a repository is `<name>` under a Gateway image repository: any `…/gateway/<name>`, or an official one. */
function isGatewayComponentRepository(repository: string, name: string): boolean {
  return (
    repository.endsWith(`/gateway/${name}`) ||
    OFFICIAL_IMAGE_REPOSITORIES.some((official) => repository === `${official}/${name}`)
  );
}

function normalizedImageId(identifier: string): string {
  return identifier.trim().replace(/^sha256:/, '');
}

export function dockerImageId(image: DockerImageLike): string {
  return String(image.id ?? image.Id ?? '');
}

export function resolveDockerImageByIdentifier(images: DockerImageLike[], identifier: string) {
  const requested = identifier.trim();
  if (!requested) return null;
  const normalizedRequestedReference = normalizedReference(requested);
  const exactMatches = images.filter((image) => {
    const id = dockerImageId(image);
    return (
      id === requested ||
      dockerImageReferences(image).some(
        (reference) => reference === requested || normalizedReference(reference) === normalizedRequestedReference
      )
    );
  });
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) return null;

  const requestedId = normalizedImageId(requested);
  if (!requestedId || requested.includes('/') || requested.includes('@') || requested.includes(':')) return null;
  const prefixMatches = images.filter((image) => normalizedImageId(dockerImageId(image)).startsWith(requestedId));
  return prefixMatches.length === 1 ? prefixMatches[0] : null;
}

export function gatewayInternalImageKind(image: DockerImageLike): GatewayInternalImageKind | null {
  for (const reference of dockerImageReferences(image)) {
    const repository = normalizedRepository(reference);
    if (
      repository === 'gateway-secure-link-connector' ||
      isGatewayComponentRepository(repository, 'secure-link-connector')
    ) {
      return 'secure-link-connector';
    }
    if (repository === 'gateway-database-connector' || isGatewayComponentRepository(repository, 'database-connector')) {
      return 'database-connector';
    }
    if (repository === 'docker/compose-bin' || repository === 'docker.io/docker/compose-bin') {
      return 'compose-sidecar';
    }
    if (repository.startsWith('gateway/builds/') || repository.includes('/gateway/builds/')) {
      return 'build-artifact';
    }
  }
  return null;
}

export function isGatewayInternalImage(image: DockerImageLike): boolean {
  return gatewayInternalImageKind(image) !== null;
}

export function filterGatewayInternalImages<T extends DockerImageLike>(images: T[]): T[] {
  return images.filter((image) => !isGatewayInternalImage(image));
}

export function isDanglingDockerImage(image: DockerImageLike): boolean {
  const tags = image.repoTags ?? image.RepoTags;
  return !Array.isArray(tags) || tags.length === 0 || tags.every((tag) => tag === '<none>:<none>');
}

export function findGatewayInternalImage(images: DockerImageLike[], imageIdOrReference: string) {
  const image = resolveDockerImageByIdentifier(images, imageIdOrReference);
  return image && isGatewayInternalImage(image) ? image : undefined;
}

export function selectObsoleteGatewayConnectorImages(
  images: DockerImageLike[],
  currentSecureLinkReference?: string | null
): GatewayInternalImageCandidate[] {
  const currentReference = currentSecureLinkReference?.trim() || null;
  const groups = new Map<string, GatewayInternalImageCandidate[]>();

  for (const image of images) {
    const kind = gatewayInternalImageKind(image);
    if (kind !== 'secure-link-connector' && kind !== 'database-connector') continue;
    if (Number(image.containers ?? image.Containers ?? 0) > 0) continue;
    const references = dockerImageReferences(image);
    if (currentReference && references.includes(currentReference)) continue;
    const repository = references.map(dockerImageRepository).find(Boolean);
    const id = String(image.id ?? image.Id ?? '');
    if (!repository || !id) continue;
    const candidate: GatewayInternalImageCandidate = {
      id,
      kind,
      repository,
      references,
      created: Number(image.created ?? image.Created ?? 0),
      size: Number(image.size ?? image.Size ?? 0),
    };
    const key = `${kind}:${repository}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  return [...groups.values()].flatMap((candidates) =>
    candidates.sort((left, right) => right.created - left.created).slice(1)
  );
}
