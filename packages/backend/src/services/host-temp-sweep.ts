import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Temporary files and directories Opfield creates in the app container's temp directory and removes when the work
 * finishes. A crash or restart in between left them for good (the temp directory lives in the container's writable
 * layer until the container is recreated). Pages upload files are handled by Pages maintenance.
 */
export const OPFIELD_TEMP_PREFIXES = [
  'opfield-git-',
  'opfield-seed-',
  'opfield-pki-export-',
  'opfield-sandbox-artifact-',
  'nginx-validate-',
] as const;

/** Work using one of these lasts minutes; anything older than this (generously) is a leftover. */
export const TEMP_LEFTOVER_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/** Removes Opfield's own temp leftovers older than TEMP_LEFTOVER_MIN_AGE_MS. Never touches other names. */
export async function sweepTempLeftovers(
  options: { root?: string; now?: number; dryRun?: boolean } = {}
): Promise<{ removed: number; bytes: number }> {
  const root = options.root ?? tmpdir();
  const now = options.now ?? Date.now();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { removed: 0, bytes: 0 };
  }
  let removed = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!OPFIELD_TEMP_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
    const path = join(root, entry);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < TEMP_LEFTOVER_MIN_AGE_MS) continue;
      bytes += info.isDirectory() ? await directorySize(path) : info.size;
      if (!options.dryRun) await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Gone already or unreadable: the next sweep tries again.
    }
  }
  return { removed, bytes };
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else
      total += await stat(child)
        .then((info) => info.size)
        .catch(() => 0);
  }
  return total;
}
