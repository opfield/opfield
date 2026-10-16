/** A succeeded build of a container's Git source, as a rollback names it. */
export interface DockerSourceRollbackBuild {
  id: string;
  commitSha: string;
  createdAt: Date;
  completedAt: Date | null;
}

/** The build a rollback of a container source goes back to, and the build the container runs now. */
export interface DockerSourceRollbackCandidate {
  build: DockerSourceRollbackBuild;
  /** The registry artifact (image digest) of `build`. */
  artifactId: string;
  /** The build the container runs now; null when Opfield has no record of it. */
  current: DockerSourceRollbackBuild | null;
  /** A build of the source that is queued, building or deploying; a rollback waits until it ends. */
  activeBuild: { id: string; status: string; commitSha: string } | null;
}

export interface DockerSourceRollbackResult {
  /** The build the container runs now. */
  build: DockerSourceRollbackBuild;
  /** The build it ran before; it stays kept as the build to return to. */
  previousBuild: DockerSourceRollbackBuild | null;
  /** Set when the container was stopped on request: the image is replaced and runs on its next start. */
  rolloutNote: string | null;
}

/**
 * Rolling a container source back to a build the internal registry keeps (commercial build rollout). `candidate`
 * answers which build that is, or refuses with an AppError naming why; `rollback` deploys it under the source's build
 * lock and records it as the running build.
 */
export interface DockerSourceArtifactRollback {
  candidate(sourceBindingId: string, buildId?: string): Promise<DockerSourceRollbackCandidate>;
  rollback(input: { sourceBindingId: string; artifactId: string; userId: string }): Promise<DockerSourceRollbackResult>;
}
