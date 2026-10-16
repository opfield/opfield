import { type NodeImageRetentionCandidate, REPLACED_IMAGE_GRACE_MS } from './docker-image-cleanup.service.js';

/** What a prune of a node would remove (DockerManagementService.previewPruneImages). */
export interface DockerImagePrunePreview {
  dryRun: true;
  nodeId: string;
  removable: Array<{
    id: string;
    repository: string | null;
    size: number;
    reason: DockerImagePruneReason;
    removableAt?: string;
  }>;
  removableBytes: number;
  waiting: Array<{
    id: string;
    repository: string | null;
    size: number;
    reason: DockerImagePruneReason;
    removableAt?: string;
  }>;
  waitingBytes: number;
}

/**
 * Why an image goes: `dangling` (nothing names it), `beyond_cleanup_setting` (an older image of a workload beyond
 * its image cleanup setting, after 2 minutes) or `unused` (nothing runs or names it, after 12 hours unused).
 */
export type DockerImagePruneReason = 'dangling' | 'beyond_cleanup_setting' | 'unused';

function pruneCandidateView(candidate: NodeImageRetentionCandidate) {
  const reason: DockerImagePruneReason =
    candidate.repository === null
      ? 'dangling'
      : candidate.minUnusedMs <= REPLACED_IMAGE_GRACE_MS
        ? 'beyond_cleanup_setting'
        : 'unused';
  return {
    id: candidate.id,
    repository: candidate.repository,
    size: candidate.size,
    reason,
    removableAt: candidate.removableAt,
  };
}

/**
 * A manual prune removes the dangling images at once and then what the image cleanup rules remove now; the rules'
 * images still within their wait are listed apart. An image in both lists counts once.
 */
export function buildImagePrunePreview(
  nodeId: string,
  dangling: Array<{ id: string; size: number }>,
  rules: { candidates: NodeImageRetentionCandidate[]; waiting: NodeImageRetentionCandidate[] }
): DockerImagePrunePreview {
  const danglingIds = new Set(dangling.map((image) => image.id));
  const removable: DockerImagePrunePreview['removable'] = [
    ...dangling.map((image) => ({ id: image.id, repository: null, size: image.size, reason: 'dangling' as const })),
    ...rules.candidates
      .filter((candidate) => !danglingIds.has(candidate.id))
      .map((candidate) => ({ ...pruneCandidateView(candidate), removableAt: undefined })),
  ];
  const waiting = rules.waiting.filter((candidate) => !danglingIds.has(candidate.id)).map(pruneCandidateView);
  return {
    dryRun: true,
    nodeId,
    removable,
    removableBytes: removable.reduce((sum, image) => sum + image.size, 0),
    waiting,
    waitingBytes: waiting.reduce((sum, image) => sum + image.size, 0),
  };
}
