import { and, desc, eq, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerArtifactPins, dockerBuildArtifacts, dockerBuilds, dockerSourceBindings } from '@/db/schema/index.js';

/**
 * A container whose Git source is detached keeps running the build it ran. The source's build artifacts go with the
 * source, and the registry would delete that build 12 hours later, so a recreate on another node, a migration or a
 * pull on a fresh node would find nothing. The build is kept instead as the container's own artifact
 * (`owner_kind = 'container'`, owner key `container:<node>:<name>`) until the container is removed or runs another
 * image: retention keeps it while the container exists, and the deletion of the old source's repository spares it.
 */

const INTERNAL_REGISTRY = '127.0.0.1:5443';

export function containerArtifactOwnerKey(nodeId: string, containerName: string): string {
  return `container:${nodeId}:${containerName}`;
}

export interface ContainerKeptImage {
  /** The reference the container runs, kept in the internal registry. */
  reference: string;
  repository: string;
  digest: string;
  note: string;
}

type ArtifactRow = typeof dockerBuildArtifacts.$inferSelect;

/**
 * The build the container of a source runs now: the artifact of its active pin, else the newest ready one of the
 * deployed commit. Null when nothing of the source was deployed to it.
 */
export async function runningSourceArtifact(
  db: DrizzleClient,
  target: { nodeId: string; containerName: string }
): Promise<ArtifactRow | null> {
  const [binding] = await db
    .select({ id: dockerSourceBindings.id, deployedCommitSha: dockerSourceBindings.deployedCommitSha })
    .from(dockerSourceBindings)
    .where(
      and(
        eq(dockerSourceBindings.targetKind, 'container'),
        eq(dockerSourceBindings.nodeId, target.nodeId),
        eq(dockerSourceBindings.containerName, target.containerName)
      )
    )
    .limit(1);
  if (!binding) return null;
  const [active] = await db
    .select({ artifact: dockerBuildArtifacts })
    .from(dockerArtifactPins)
    .innerJoin(dockerBuildArtifacts, eq(dockerBuildArtifacts.id, dockerArtifactPins.artifactId))
    .where(
      and(
        eq(dockerArtifactPins.kind, 'active'),
        eq(dockerArtifactPins.ownerKey, containerArtifactOwnerKey(target.nodeId, target.containerName)),
        eq(dockerBuildArtifacts.sourceBindingId, binding.id),
        eq(dockerBuildArtifacts.status, 'ready')
      )
    )
    .orderBy(desc(dockerArtifactPins.createdAt))
    .limit(1);
  if (active) return active.artifact;
  if (!binding.deployedCommitSha) return null;
  const [deployed] = await db
    .select({ artifact: dockerBuildArtifacts })
    .from(dockerBuildArtifacts)
    .innerJoin(dockerBuilds, eq(dockerBuilds.id, dockerBuildArtifacts.buildId))
    .where(
      and(
        eq(dockerBuildArtifacts.sourceBindingId, binding.id),
        eq(dockerBuildArtifacts.status, 'ready'),
        eq(dockerBuilds.commitSha, binding.deployedCommitSha)
      )
    )
    .orderBy(desc(dockerBuildArtifacts.createdAt))
    .limit(1);
  return deployed?.artifact ?? null;
}

/** Keeps `artifact` (read before the source was detached) as the container's own; replaces an earlier kept one. */
export async function keepContainerImage(
  db: DrizzleClient,
  target: { nodeId: string; containerName: string },
  artifact: ArtifactRow
): Promise<ContainerKeptImage> {
  const ownerKey = containerArtifactOwnerKey(target.nodeId, target.containerName);
  const reference = `${INTERNAL_REGISTRY}/${artifact.registryRepository}@${artifact.digest}`;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(dockerBuildArtifacts)
      .set({ status: 'deleted', updatedAt: now })
      .where(
        and(
          eq(dockerBuildArtifacts.ownerKind, 'container'),
          eq(dockerBuildArtifacts.ownerKey, ownerKey),
          ne(dockerBuildArtifacts.status, 'deleted')
        )
      );
    await tx.insert(dockerBuildArtifacts).values({
      ownerKind: 'container',
      ownerKey,
      sourceImageReference: reference,
      registryRepository: artifact.registryRepository,
      digest: artifact.digest,
      platform: artifact.platform,
      sizeBytes: artifact.sizeBytes,
      status: 'ready',
      sbomDigest: artifact.sbomDigest,
      provenanceDigest: artifact.provenanceDigest,
      scanSummary: artifact.scanSummary,
      policyDecision: artifact.policyDecision,
      policyReason: artifact.policyReason,
      verifiedAt: artifact.verifiedAt,
    });
  });
  return {
    reference,
    repository: artifact.registryRepository,
    digest: artifact.digest,
    note: 'The container keeps running this image. The internal registry keeps it as the container’s own image until the container is removed or runs another image, so a recreate or a migration can still pull it.',
  };
}

/**
 * The container was removed, or runs another image now (`runningDigest`, when it still runs one from the registry):
 * its kept image is no longer needed and retention deletes it.
 */
export async function releaseContainerImage(
  db: DrizzleClient,
  target: { nodeId: string; containerName: string },
  runningDigest?: string | null
): Promise<void> {
  const ownerKey = containerArtifactOwnerKey(target.nodeId, target.containerName);
  await db
    .update(dockerBuildArtifacts)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(
      and(
        eq(dockerBuildArtifacts.ownerKind, 'container'),
        eq(dockerBuildArtifacts.ownerKey, ownerKey),
        ne(dockerBuildArtifacts.status, 'deleted'),
        ...(runningDigest ? [ne(dockerBuildArtifacts.digest, runningDigest.toLowerCase())] : [])
      )
    );
}

/** The container was renamed: its kept image goes with it. */
export async function renameContainerImage(
  db: DrizzleClient,
  nodeId: string,
  oldName: string,
  newName: string
): Promise<void> {
  await db
    .update(dockerBuildArtifacts)
    .set({ ownerKey: containerArtifactOwnerKey(nodeId, newName), updatedAt: new Date() })
    .where(
      and(
        eq(dockerBuildArtifacts.ownerKind, 'container'),
        eq(dockerBuildArtifacts.ownerKey, containerArtifactOwnerKey(nodeId, oldName)),
        ne(dockerBuildArtifacts.status, 'deleted')
      )
    );
}

/** The digest an image reference names (`…@sha256:…`), lower case; null for a tag. */
export function imageReferenceDigest(reference: string | null | undefined): string | null {
  const match = /@(sha256:[0-9a-f]{64})$/i.exec(reference?.trim() ?? '');
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Detaches the Git source of a container that exists and keeps the build it runs as its own (see the top of this
 * file). `remove` is the source service's detach; nothing is kept when it did not detach.
 */
export async function detachContainerSourceKeepingImage(
  db: DrizzleClient,
  remove: () => Promise<boolean>,
  target: { nodeId: string; containerName: string }
): Promise<{ removed: boolean; keptImage: ContainerKeptImage | null }> {
  const running = await runningSourceArtifact(db, target);
  const removed = await remove();
  if (!removed || !running) return { removed, keptImage: null };
  return { removed, keptImage: await keepContainerImage(db, target, running) };
}
