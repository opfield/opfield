/** The installation's Compose directory: the configured one, else the one Compose started this container from. */
export function composeDirectoryOf(
  env: { COMPOSE_PROJECT_DIR?: string },
  labels: Record<string, string> | undefined
): string | null {
  return env.COMPOSE_PROJECT_DIR || labels?.['com.docker.compose.project.working_dir'] || null;
}
