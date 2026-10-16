import {
  canonicalDockerReference,
  dockerImageId,
  dockerImageReferences,
  isOpfieldInternalImage,
} from './docker-internal-images.js';

type DockerImageLike = Record<string, any>;

/** The image cleanup setting of a container or deployment when none was saved: on, the running image and one more. */
export const DEFAULT_IMAGE_RETENTION_COUNT = 2;

const BUILD_REPOSITORY_PREFIX = 'gateway/builds/';

/**
 * The repository an image reference belongs to, for counting a container's images: tags and digests both count, so
 * an image pulled by digest only (`repo@sha256:…`, as every build image is) matches its repository too. A build
 * image's repository is the same whatever address of Opfield's registry pulled it (`gateway/builds/<source>[/<service>]`).
 * Null for an image ID or a reference without a repository.
 */
export function imageRetentionRepository(reference: string): string | null {
  const value = reference.trim();
  if (!value || value.startsWith('<none>') || /^(sha256:)?[0-9a-f]{12,64}$/i.test(value)) return null;
  const { repository } = canonicalDockerReference(value);
  const build = repository.indexOf(BUILD_REPOSITORY_PREFIX);
  if (build === 0 || (build > 0 && repository[build - 1] === '/')) return repository.slice(build);
  return repository;
}

export function isBuildImageRepository(repository: string): boolean {
  return repository.startsWith(BUILD_REPOSITORY_PREFIX);
}

/** The build repositories of one Git source: its own and, for a Compose project, one per service. */
export function isSourceBuildRepository(repository: string, sourceBindingId: string): boolean {
  const own = `${BUILD_REPOSITORY_PREFIX}${sourceBindingId}`;
  return repository === own || repository.startsWith(`${own}/`);
}

/** A registry artifact as the node sees it: `<repository>@<digest>`, the repository without a registry address. */
export function imageRetentionDigestKey(repository: string, digest: string): string {
  return `${repository}@${digest.toLowerCase()}`;
}

export interface ImageRetentionEntry {
  id: string;
  repository: string;
  references: string[];
  digestKeys: string[];
  created: number;
  size: number;
  inUse: boolean;
}

/**
 * Whether a container (running or stopped) uses the image: the node counts the containers per image, and the
 * container list's image IDs are checked besides. An image whose count the node did not report is judged by the
 * container list alone; Docker itself refuses to remove an image a container uses.
 */
function imageInUse(image: DockerImageLike, inUseImageIds: ReadonlySet<string>): boolean {
  const id = dockerImageId(image);
  if (inUseImageIds.has(id) || inUseImageIds.has(id.replace(/^sha256:/, ''))) return true;
  const containers = Number(image.containers ?? image.Containers);
  return Number.isFinite(containers) && containers > 0;
}

/** The node's images grouped per repository (an image with references in two repositories is in both). */
export function groupImagesByRepository(
  images: DockerImageLike[],
  inUseImageIds: ReadonlySet<string> = new Set()
): Map<string, ImageRetentionEntry[]> {
  const groups = new Map<string, ImageRetentionEntry[]>();
  for (const image of images) {
    const id = dockerImageId(image);
    if (!id) continue;
    const references = dockerImageReferences(image).filter((reference) => !reference.startsWith('<none>'));
    const repositories = new Set<string>();
    const digestKeys: string[] = [];
    for (const reference of references) {
      const repository = imageRetentionRepository(reference);
      if (!repository) continue;
      repositories.add(repository);
      const digest = reference.includes('@') ? reference.slice(reference.indexOf('@') + 1) : '';
      if (/^sha256:[0-9a-f]{64}$/i.test(digest)) digestKeys.push(imageRetentionDigestKey(repository, digest));
    }
    for (const repository of repositories) {
      const entry: ImageRetentionEntry = {
        id,
        repository,
        references,
        digestKeys,
        created: Number(image.created ?? image.Created ?? 0),
        size: Number(image.size ?? image.Size ?? 0),
        inUse: imageInUse(image, inUseImageIds),
      };
      groups.set(repository, [...(groups.get(repository) ?? []), entry]);
    }
  }
  return groups;
}

/**
 * The images of one repository a node keeps, at most `retentionCount` besides those a container uses: every image a
 * container (running or stopped) uses, every build the internal registry keeps for rollback (`protectedDigestKeys`),
 * and the newest other images until the running one and `retentionCount - 1` to roll back to are there. With the
 * default 2 this is the running build and one rollback build. Everything else is removable.
 */
export function selectImageRetention(
  entries: ImageRetentionEntry[],
  retentionCount: number,
  protectedDigestKeys: ReadonlySet<string> = new Set()
): { kept: ImageRetentionEntry[]; removable: ImageRetentionEntry[] } {
  const ordered = [...entries].sort((left, right) => right.created - left.created || left.id.localeCompare(right.id));
  const kept = new Set<string>();
  for (const entry of ordered) {
    if (entry.inUse || entry.digestKeys.some((key) => protectedDigestKeys.has(key))) kept.add(entry.id);
  }
  const keptUnused = ordered.filter((entry) => kept.has(entry.id) && !entry.inUse).length;
  let rollbackSlots = Math.max(0, Math.max(1, Math.floor(retentionCount)) - 1 - keptUnused);
  for (const entry of ordered) {
    if (rollbackSlots <= 0) break;
    if (kept.has(entry.id)) continue;
    kept.add(entry.id);
    rollbackSlots -= 1;
  }
  return {
    kept: ordered.filter((entry) => kept.has(entry.id)),
    removable: ordered.filter((entry) => !kept.has(entry.id)),
  };
}

/**
 * Images nothing names and no container uses: no tag, no digest, not one of Opfield's own, and not the parent of
 * another image (Docker refuses those). A digest-only image (pulled by `repo@sha256:…`) is not dangling.
 */
export function selectDanglingImages(
  images: DockerImageLike[],
  inUseImageIds: ReadonlySet<string> = new Set()
): Array<{ id: string; size: number }> {
  const parents = new Set(
    images.map((image) => String(image.parentId ?? image.ParentId ?? '')).filter((parent) => parent.length > 0)
  );
  return images.flatMap((image) => {
    const id = dockerImageId(image);
    if (!id || parents.has(id) || isOpfieldInternalImage(image)) return [];
    if (dockerImageReferences(image).some((reference) => !reference.startsWith('<none>'))) return [];
    const containers = Number(image.containers ?? image.Containers);
    if (!Number.isFinite(containers) || containers !== 0 || imageInUse(image, inUseImageIds)) return [];
    return [{ id, size: Number(image.size ?? image.Size ?? 0) }];
  });
}
