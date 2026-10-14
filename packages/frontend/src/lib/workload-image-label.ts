import { formatDisplayImageRef } from "@/lib/docker-image-ref";
import type { DockerImageSource } from "@/types";

/** The Git source a workload's image was built from (container, deployment or Compose service). */
export type WorkloadImageSource = DockerImageSource;

/** Length of a commit in labels, the same everywhere a source is named. */
const SHORT_COMMIT_LENGTH = 10;

/** Repositories of images Opfield pushes to its internal registry: Git builds, Availability mirrors, promotions. */
const INTERNAL_REPOSITORY_RE = /^(?:gateway\/builds|gateway\/availability|gateway\/promotion)\//i;
const INTERNAL_REGISTRY_HOSTS = new Set(["127.0.0.1:5443", "localhost:5443", "registry.internal"]);

export function shortCommitSha(sha: string | null | undefined): string {
  return (sha ?? "").slice(0, SHORT_COMMIT_LENGTH);
}

/** Whether an image reference points at Opfield's internal registry rather than an image the user named. */
export function isInternalRegistryImage(reference: string | null | undefined): boolean {
  const value = (reference ?? "").trim();
  if (!value) return false;
  const firstSlash = value.indexOf("/");
  if (firstSlash > 0 && INTERNAL_REGISTRY_HOSTS.has(value.slice(0, firstSlash).toLowerCase()))
    return true;
  return INTERNAL_REPOSITORY_RE.test(value);
}

/** "owner/repo · 0123456789": the label the container page shows for a Git-built workload. */
export function formatWorkloadSource(source: WorkloadImageSource): string {
  const commit = shortCommitSha(source.commitSha);
  return commit ? `${source.repositoryFullPath} · ${commit}` : source.repositoryFullPath;
}

/** Hover text for a source label: repository, branch and the full commit. */
export function workloadSourceTitle(source: WorkloadImageSource): string {
  return [
    source.repositoryFullPath,
    source.branch ? `branch ${source.branch}` : null,
    source.commitSha ? `commit ${source.commitSha}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** The `source` / `sourceImage` props of an image a deployment reports in `imageOrigins`. */
export function deploymentImageOrigin(
  deployment: {
    imageOrigins?: Record<string, { source: DockerImageSource | null; sourceImage: string | null }>;
  },
  image: string | null | undefined
): { source: DockerImageSource | null; sourceImage: string | null } {
  return deployment.imageOrigins?.[(image ?? "").trim()] ?? { source: null, sourceImage: null };
}

export interface WorkloadImageLabel {
  /** What a list shows: the Git source, the image the user named, or a placeholder. */
  text: string;
  /** Hover text with the full value. */
  title: string;
  /** "source" when the text names a Git repository. */
  kind: "source" | "image" | "pending" | "internal" | "none";
}

/**
 * The image column of a container, deployment or Compose service. A workload built from Git runs an image in the
 * internal registry: lists name its repository and commit, like the container page. Any other image is shown as the
 * user named it, without a registry host; an internal copy of an image as the image it was copied from. An internal
 * image whose origin is unknown never shows the internal registry: it reads "Built image".
 */
export function workloadImageLabel(workload: {
  image?: string | null;
  source?: WorkloadImageSource | null;
  /** The image an Availability mirror or promotion copy in the internal registry was taken from. */
  sourceImage?: string | null;
  pendingSourceBuild?: boolean;
}): WorkloadImageLabel {
  const runtimeImage = (workload.image ?? "").trim();
  const copiedFrom = (workload.sourceImage ?? "").trim();
  const image = copiedFrom && isInternalRegistryImage(runtimeImage) ? copiedFrom : runtimeImage;
  const source = workload.source?.repositoryFullPath ? workload.source : null;
  if (workload.pendingSourceBuild) {
    return {
      text: "Awaiting build",
      title: source ? workloadSourceTitle(source) : "Awaiting build",
      kind: "pending",
    };
  }
  if (source && (!image || isInternalRegistryImage(image))) {
    return {
      text: formatWorkloadSource(source),
      title: workloadSourceTitle(source),
      kind: "source",
    };
  }
  if (!image) return { text: "—", title: "", kind: "none" };
  if (isInternalRegistryImage(image)) {
    return { text: "Built image", title: formatDisplayImageRef(image), kind: "internal" };
  }
  return { text: formatDisplayImageRef(image), title: image, kind: "image" };
}
