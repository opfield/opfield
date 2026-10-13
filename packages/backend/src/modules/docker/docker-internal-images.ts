import { OFFICIAL_IMAGE_REPOSITORIES } from '@/config/vendor-urls.js';

export type OpfieldInternalImageKind =
  | 'secure-link-connector'
  | 'database-connector'
  | 'compose-sidecar'
  | 'build-artifact';

type DockerImageLike = Record<string, any>;

export interface OpfieldInternalImageCandidate {
  id: string;
  kind: Exclude<OpfieldInternalImageKind, 'compose-sidecar'>;
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
function isOpfieldComponentRepository(repository: string, name: string): boolean {
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

const DOCKER_HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

/**
 * A reference in the form Docker stores it, so `python:3.13-alpine`, `library/python:3.13-alpine` and
 * `docker.io/library/python:3.13-alpine` compare equal: registry host (Docker Hub's aliases as docker.io), path
 * (`library/` for an official image), tag (latest when neither a tag nor a digest is named) and digest.
 */
export function canonicalDockerReference(reference: string): {
  repository: string;
  tag: string | null;
  digest: string | null;
} {
  const [name = '', digestPart] = reference.trim().split('@', 2);
  const digest = digestPart && /^sha256:[0-9a-f]{64}$/i.test(digestPart) ? digestPart.toLowerCase() : null;
  const lastSlash = name.lastIndexOf('/');
  const lastColon = name.lastIndexOf(':');
  const path = lastColon > lastSlash ? name.slice(0, lastColon) : name;
  const tag = lastColon > lastSlash ? name.slice(lastColon + 1) : digest ? null : 'latest';
  const firstSlash = path.indexOf('/');
  const first = firstSlash >= 0 ? path.slice(0, firstSlash) : '';
  const hasHost = first === 'localhost' || first.includes('.') || first.includes(':');
  const host = hasHost ? (DOCKER_HUB_HOSTS.has(first.toLowerCase()) ? 'docker.io' : first.toLowerCase()) : 'docker.io';
  let rest = hasHost ? path.slice(firstSlash + 1) : path;
  if (host === 'docker.io' && !rest.includes('/')) rest = `library/${rest}`;
  return { repository: `${host}/${rest}`, tag, digest };
}

function uniqueImage<T>(matches: T[]): T | null {
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * The image a pull of `imageRef` left on the node, read from the image list after the pull. Docker stores
 * references in its own form: Hub images without `docker.io/library/`, an image pulled by `repo:tag@digest` only as
 * `repo@digest`. So after an exact match this compares canonical references: by digest (same repository first,
 * then the digest alone), then by repository and tag. Last, when `existingImageIds` (the list before the pull) is
 * known: the one new image of that repository (or without any reference). Null when it cannot be told.
 */
export function resolvePulledDockerImage<T extends DockerImageLike>(
  images: T[],
  imageRef: string,
  existingImageIds?: ReadonlySet<string>
): T | null {
  const exact = resolveDockerImageByIdentifier(images, imageRef);
  if (exact) return exact as T;
  const requested = canonicalDockerReference(imageRef);
  const digestsOf = (image: T) =>
    dockerImageReferences(image)
      .filter((reference) => reference.includes('@'))
      .map(canonicalDockerReference);
  const tagsOf = (image: T) =>
    dockerImageReferences(image)
      .filter((reference) => !reference.includes('@') && reference !== '<none>:<none>')
      .map(canonicalDockerReference);
  const withReference = (test: (entry: ReturnType<typeof canonicalDockerReference>) => boolean, digests: boolean) =>
    uniqueImage(images.filter((image) => (digests ? digestsOf(image) : tagsOf(image)).some(test)));
  if (requested.digest) {
    const sameRepository = withReference(
      (entry) => entry.digest === requested.digest && entry.repository === requested.repository,
      true
    );
    if (sameRepository) return sameRepository;
    const sameDigest = withReference((entry) => entry.digest === requested.digest, true);
    if (sameDigest) return sameDigest;
  } else {
    const sameTag = withReference(
      (entry) => entry.repository === requested.repository && entry.tag === requested.tag,
      false
    );
    if (sameTag) return sameTag;
  }
  if (!existingImageIds) return null;
  // A new image of another repository came from another pull at the same time: never take it for this one.
  const fresh = images.filter((image) => !existingImageIds.has(dockerImageId(image)));
  return uniqueImage(
    fresh.filter((image) => {
      const references = [...digestsOf(image), ...tagsOf(image)];
      return references.length === 0 || references.some((entry) => entry.repository === requested.repository);
    })
  );
}

export function opfieldInternalImageKind(image: DockerImageLike): OpfieldInternalImageKind | null {
  for (const reference of dockerImageReferences(image)) {
    const repository = normalizedRepository(reference);
    if (
      repository === 'gateway-secure-link-connector' ||
      isOpfieldComponentRepository(repository, 'secure-link-connector')
    ) {
      return 'secure-link-connector';
    }
    if (repository === 'gateway-database-connector' || isOpfieldComponentRepository(repository, 'database-connector')) {
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

export function isOpfieldInternalImage(image: DockerImageLike): boolean {
  return opfieldInternalImageKind(image) !== null;
}

export function filterOpfieldInternalImages<T extends DockerImageLike>(images: T[]): T[] {
  return images.filter((image) => !isOpfieldInternalImage(image));
}

export function isDanglingDockerImage(image: DockerImageLike): boolean {
  const tags = image.repoTags ?? image.RepoTags;
  return !Array.isArray(tags) || tags.length === 0 || tags.every((tag) => tag === '<none>:<none>');
}

export function findOpfieldInternalImage(images: DockerImageLike[], imageIdOrReference: string) {
  const image = resolveDockerImageByIdentifier(images, imageIdOrReference);
  return image && isOpfieldInternalImage(image) ? image : undefined;
}

export function selectObsoleteOpfieldConnectorImages(
  images: DockerImageLike[],
  currentSecureLinkReference?: string | null
): OpfieldInternalImageCandidate[] {
  const currentReference = currentSecureLinkReference?.trim() || null;
  const groups = new Map<string, OpfieldInternalImageCandidate[]>();

  for (const image of images) {
    const kind = opfieldInternalImageKind(image);
    if (kind !== 'secure-link-connector' && kind !== 'database-connector') continue;
    if (Number(image.containers ?? image.Containers ?? 0) > 0) continue;
    const references = dockerImageReferences(image);
    if (currentReference && references.includes(currentReference)) continue;
    const repository = references.map(dockerImageRepository).find(Boolean);
    const id = String(image.id ?? image.Id ?? '');
    if (!repository || !id) continue;
    const candidate: OpfieldInternalImageCandidate = {
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
