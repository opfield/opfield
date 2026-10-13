import { readFileSync } from 'node:fs';

const IMMUTABLE_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

// Kept inside the signed Opfield image, not in the persistent host environment.
// Older Compose files pass BACKUP_RUNNER_IMAGE=""; that must retain the default.
export function resolveBackupRunnerImage(
  override?: string,
  bundleUrl = new URL('./backup-runner-image.json', import.meta.url)
): string | undefined {
  const explicit = override?.trim();
  if (explicit) {
    if (!IMMUTABLE_IMAGE.test(explicit)) throw new Error('BACKUP_RUNNER_IMAGE must be an immutable image reference');
    return explicit;
  }
  let raw: string;
  try {
    raw = readFileSync(bundleUrl, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const bundle = JSON.parse(raw) as { schemaVersion?: number; image?: string };
  if (bundle.schemaVersion !== 1 || typeof bundle.image !== 'string' || !IMMUTABLE_IMAGE.test(bundle.image)) {
    throw new Error('Invalid bundled backup runner image');
  }
  return bundle.image;
}
