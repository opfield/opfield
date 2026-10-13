import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerBuildArtifacts, dockerBuilds, dockerSourceBindings } from '@/db/schema/index.js';

/** Host of the internal registry Git builds, Availability mirrors and promotion copies are pushed to. */
export const INTERNAL_REGISTRY_PREFIX = '127.0.0.1:5443/';

/** The Git source an image was built from: what lists show instead of the internal registry reference. */
export interface DockerImageSource {
  repositoryFullPath: string;
  branch: string | null;
  commitSha: string | null;
}

/** What an internal image stands for: the Git source it was built from, or the image it is a copy of. */
export type DockerImageOrigin = { source: DockerImageSource } | { image: string };

interface InternalImageReference {
  repository: string;
  digest: string | null;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
const BUILD_REPOSITORY_RE = /^gateway\/builds\/([0-9a-f-]{36})(?:\/|$)/i;
/** Availability mirrors and promotion copies point at another image; follow at most this many hops. */
const MAX_HOPS = 3;

/** `127.0.0.1:5443/<repository>[:tag][@digest]` split into repository and digest; null for any other image. */
export function parseInternalImageReference(reference: string | null | undefined): InternalImageReference | null {
  const value = (reference ?? '').trim();
  if (!value.startsWith(INTERNAL_REGISTRY_PREFIX)) return null;
  const rest = value.slice(INTERNAL_REGISTRY_PREFIX.length);
  const [name = '', digestPart] = rest.split('@', 2);
  const lastSlash = name.lastIndexOf('/');
  const lastColon = name.lastIndexOf(':');
  const repository = lastColon > lastSlash ? name.slice(0, lastColon) : name;
  if (!repository) return null;
  return { repository, digest: digestPart && DIGEST_RE.test(digestPart) ? digestPart.toLowerCase() : null };
}

function referenceKey(reference: InternalImageReference): string {
  return `${reference.repository}@${reference.digest ?? ''}`;
}

function database(): DrizzleClient | null {
  return container.isRegistered(TOKENS.DrizzleClient) ? container.resolve<DrizzleClient>(TOKENS.DrizzleClient) : null;
}

/**
 * What each internal image reference stands for: the build artifact (by repository and digest, or the newest one of
 * the repository for a tag) gives the Git repository, branch and commit; an Availability mirror or promotion copy is
 * followed to the image it copied, which is the answer when that image is not internal. A build repository whose
 * artifact is gone still names its source binding. References that are not internal, or whose origin is unknown, are
 * absent from the result.
 */
export async function resolveDockerImageOrigins(
  references: Iterable<string | null | undefined>,
  db: DrizzleClient | null = database()
): Promise<Map<string, DockerImageOrigin>> {
  const result = new Map<string, DockerImageOrigin>();
  if (!db) return result;
  const roots = new Map<string, InternalImageReference>();
  for (const reference of references) {
    const parsed = parseInternalImageReference(reference);
    if (parsed && reference) roots.set(reference.trim(), parsed);
  }
  if (roots.size === 0) return result;

  // Each pending key maps back to the original references it answers for.
  let pending = new Map<string, { reference: InternalImageReference; origins: string[] }>();
  for (const [origin, reference] of roots) {
    const key = referenceKey(reference);
    const entry = pending.get(key) ?? { reference, origins: [] };
    entry.origins.push(origin);
    pending.set(key, entry);
  }

  for (let hop = 0; hop < MAX_HOPS && pending.size > 0; hop += 1) {
    const entries = [...pending.values()];
    const conditions = entries.map(({ reference }) =>
      reference.digest
        ? and(
            eq(dockerBuildArtifacts.registryRepository, reference.repository),
            eq(dockerBuildArtifacts.digest, reference.digest)
          )
        : eq(dockerBuildArtifacts.registryRepository, reference.repository)
    );
    const rows = await db
      .select({
        registryRepository: dockerBuildArtifacts.registryRepository,
        digest: dockerBuildArtifacts.digest,
        sourceImageReference: dockerBuildArtifacts.sourceImageReference,
        repositoryFullPath: dockerBuilds.repositoryFullPath,
        ref: dockerBuilds.ref,
        commitSha: dockerBuilds.commitSha,
      })
      .from(dockerBuildArtifacts)
      .leftJoin(dockerBuilds, eq(dockerBuilds.id, dockerBuildArtifacts.buildId))
      .where(conditions.length === 1 ? conditions[0] : or(...conditions))
      .orderBy(desc(dockerBuildArtifacts.createdAt));

    const next = new Map<string, { reference: InternalImageReference; origins: string[] }>();
    const unresolved: Array<{ reference: InternalImageReference; origins: string[] }> = [];
    for (const entry of entries) {
      const { reference, origins } = entry;
      const row = rows.find(
        (candidate) =>
          candidate.registryRepository === reference.repository &&
          (!reference.digest || candidate.digest === reference.digest)
      );
      if (row?.repositoryFullPath) {
        const source: DockerImageSource = {
          repositoryFullPath: row.repositoryFullPath,
          branch: branchName(row.ref),
          commitSha: row.commitSha ?? null,
        };
        for (const origin of origins) result.set(origin, { source });
        continue;
      }
      const copiedImage = row?.sourceImageReference?.trim();
      const copied = parseInternalImageReference(copiedImage);
      if (copiedImage && !copied) {
        for (const origin of origins) result.set(origin, { image: copiedImage });
        continue;
      }
      if (copied) {
        const key = referenceKey(copied);
        const target = next.get(key) ?? { reference: copied, origins: [] };
        target.origins.push(...origins);
        next.set(key, target);
        continue;
      }
      unresolved.push(entry);
    }
    await resolveFromBindings(db, unresolved, result);
    pending = next;
  }
  return result;
}

/** `refs/heads/main` → `main`; other refs as they are. */
function branchName(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

async function resolveFromBindings(
  db: DrizzleClient,
  entries: Array<{ reference: InternalImageReference; origins: string[] }>,
  result: Map<string, DockerImageOrigin>
): Promise<void> {
  const byBinding = new Map<string, string[]>();
  for (const { reference, origins } of entries) {
    const bindingId = BUILD_REPOSITORY_RE.exec(reference.repository)?.[1]?.toLowerCase();
    if (bindingId) byBinding.set(bindingId, [...(byBinding.get(bindingId) ?? []), ...origins]);
  }
  if (byBinding.size === 0) return;
  const bindings = await db
    .select({
      id: dockerSourceBindings.id,
      repositoryFullPath: dockerSourceBindings.repositoryFullPath,
      branch: dockerSourceBindings.branch,
    })
    .from(dockerSourceBindings)
    .where(inArray(dockerSourceBindings.id, [...byBinding.keys()]));
  for (const binding of bindings) {
    const source: DockerImageSource = {
      repositoryFullPath: binding.repositoryFullPath,
      branch: binding.branch,
      commitSha: null,
    };
    for (const origin of byBinding.get(binding.id.toLowerCase()) ?? []) result.set(origin, { source });
  }
}

/**
 * Rows of a container or deployment list with what lists show for an internal image: `source`, the Git source it was
 * built from (a row that already carries one, like a container whose first build has not run yet, keeps it), and
 * `sourceImage`, the image an Availability mirror or promotion copy was taken from. Both null for any other image.
 * Never fails the list.
 */
export async function withDockerImageSources<T extends Record<string, any>>(
  rows: T[],
  imageOf: (row: T) => string | null | undefined = (row) => row.image ?? row.Image
): Promise<Array<T & { source: DockerImageSource | null; sourceImage: string | null }>> {
  let origins = new Map<string, DockerImageOrigin>();
  try {
    origins = await resolveDockerImageOrigins(rows.map(imageOf));
  } catch {
    // The label falls back to the image reference.
  }
  return rows.map((row) => {
    const image = imageOf(row)?.trim();
    const origin = image ? origins.get(image) : undefined;
    const known = row.source && typeof row.source === 'object' ? (row.source as DockerImageSource) : null;
    return {
      ...row,
      source: origin && 'source' in origin ? origin.source : known,
      sourceImage: origin && 'image' in origin ? origin.image : null,
    };
  });
}

/**
 * `imageSource` and `imageSourceImage` of one image (detail responses): its Git source, or the image an internal copy
 * was taken from; both null for any other image. Never fails the response.
 */
export async function dockerImageOriginFields(
  image: string | null | undefined
): Promise<{ imageSource: DockerImageSource | null; imageSourceImage: string | null }> {
  const reference = image?.trim();
  if (!reference || !parseInternalImageReference(reference)) return { imageSource: null, imageSourceImage: null };
  try {
    const origin = (await resolveDockerImageOrigins([reference])).get(reference);
    return {
      imageSource: origin && 'source' in origin ? origin.source : null,
      imageSourceImage: origin && 'image' in origin ? origin.image : null,
    };
  } catch {
    return { imageSource: null, imageSourceImage: null };
  }
}

/**
 * `imageOrigins` of a detail response with several images (a deployment's desired image and slots): per internal
 * reference its Git source or the image it copies. Never fails the response.
 */
export async function dockerImageOriginMap(
  references: Array<string | null | undefined>
): Promise<Record<string, { source: DockerImageSource | null; sourceImage: string | null }>> {
  const result: Record<string, { source: DockerImageSource | null; sourceImage: string | null }> = {};
  try {
    for (const [reference, origin] of await resolveDockerImageOrigins(references)) {
      result[reference] = {
        source: 'source' in origin ? origin.source : null,
        sourceImage: 'image' in origin ? origin.image : null,
      };
    }
  } catch {
    // Labels fall back to the image reference.
  }
  return result;
}
