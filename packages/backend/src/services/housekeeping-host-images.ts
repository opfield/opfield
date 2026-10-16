import { OFFICIAL_IMAGE_REPOSITORIES } from '@/config/vendor-urls.js';

/**
 * Old Opfield images on the Opfield host: the app and the relay. Updates pull them by digest (`repo@sha256:…`), so
 * they have no tag and a rule by tag never finds them. Per image family (app, relay) the host keeps every image a
 * container uses (running or stopped), the image Opfield itself runs, the relay image Opfield is configured with, and
 * the newest other one to roll back to; older ones go. Images of other repositories are not touched.
 */

export interface HostImage {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created?: number;
  Size?: number;
}

export interface HostImageSelection {
  id: string;
  family: 'app' | 'relay';
  size: number;
}

/** The repository of a reference: without tag or digest, Docker Hub's prefixes dropped. */
function referenceRepository(reference: string): string {
  const withoutDigest = reference.split('@', 1)[0]!;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  const repository = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  return repository.replace(/^(docker\.io|index\.docker\.io)\/(library\/)?/, '');
}

/**
 * legacy-name: images published before Opfield (`…/wiolett/gateway`, the local `gateway`) are the app's too.
 * The repositories Opfield's app image was published under: the one it runs from, the configured update
 * repositories, the official ones, the earlier self-hosted `…/wiolett/gateway` and the local `gateway` of early
 * installs. The relay image is `<app repository>/relay`.
 */
export function opfieldHostImageRepositories(currentImage: string, configured: string[] = []): Set<string> {
  const current = referenceRepository(currentImage);
  return new Set([current, ...configured.map(referenceRepository), ...OFFICIAL_IMAGE_REPOSITORIES, 'gateway']);
}

// legacy-name: the app and relay images of installs from before Opfield (`…/wiolett/gateway`).
function imageFamily(image: HostImage, appRepositories: ReadonlySet<string>): 'app' | 'relay' | null {
  for (const reference of [...(image.RepoTags ?? []), ...(image.RepoDigests ?? [])]) {
    if (!reference || reference.startsWith('<none>')) continue;
    const repository = referenceRepository(reference);
    if (appRepositories.has(repository) || repository.endsWith('/wiolett/gateway')) return 'app';
    if (repository.endsWith('/relay')) {
      const app = repository.slice(0, -'/relay'.length);
      if (appRepositories.has(app) || app.endsWith('/wiolett/gateway')) return 'relay';
    }
  }
  return null;
}

const sameId = (left: string, right: string) => left.replace(/^sha256:/, '') === right.replace(/^sha256:/, '');

export function selectOldOpfieldHostImages(input: {
  images: HostImage[];
  /** Image IDs of every container on the host, running or stopped. */
  inUseImageIds: ReadonlySet<string>;
  /** The image ID Opfield's own container runs. */
  selfImageId?: string | null;
  appRepositories: ReadonlySet<string>;
  /** References that always stay (the configured relay image). */
  keepReferences?: Array<string | null | undefined>;
}): HostImageSelection[] {
  const keepReferences = new Set(input.keepReferences?.filter((value): value is string => !!value) ?? []);
  const inUse = new Set([...input.inUseImageIds].map((id) => id.replace(/^sha256:/, '')));
  const families = new Map<'app' | 'relay', HostImage[]>();
  for (const image of input.images) {
    const family = imageFamily(image, input.appRepositories);
    if (!family) continue;
    families.set(family, [...(families.get(family) ?? []), image]);
  }
  const removable: HostImageSelection[] = [];
  for (const [family, images] of families) {
    const unused = images
      .filter((image) => {
        if (inUse.has(image.Id.replace(/^sha256:/, ''))) return false;
        if (input.selfImageId && sameId(image.Id, input.selfImageId)) return false;
        const references = [...(image.RepoTags ?? []), ...(image.RepoDigests ?? [])];
        return !references.some((reference) => keepReferences.has(reference));
      })
      .sort((left, right) => (right.Created ?? 0) - (left.Created ?? 0));
    // The newest unused one stays to roll back to (or is the update just pulled).
    for (const image of unused.slice(1)) removable.push({ id: image.Id, family, size: Number(image.Size ?? 0) });
  }
  return removable;
}
