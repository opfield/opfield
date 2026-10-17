import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Removes earlier backup directories of one kind under the Opfield backups directory: the newest `keep` stay (the
 * names sort by their timestamp), and older ones go once older than `maxAgeDays` (0: at once). Each backup holds a
 * copy of .env, secrets included, so they are not kept forever (rc.3 stand R-O-3). A failure leaves them to the next
 * run: a backup is never worth failing the operation that writes one.
 */
export async function pruneBackupDirectories(
  backupsDir: string,
  matches: (name: string) => boolean,
  options: { keep: number; maxAgeDays: number; now?: Date }
): Promise<string[]> {
  const now = (options.now ?? new Date()).getTime();
  const removed: string[] = [];
  try {
    const names = (await fs.readdir(backupsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && matches(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of names.slice(options.keep)) {
      const dir = path.join(backupsDir, name);
      const { mtimeMs } = await fs.stat(dir);
      if (now - mtimeMs < options.maxAgeDays * 24 * 60 * 60_000) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(name);
    }
  } catch {
    // Missing directory or a file that could not be removed: the next backup tries again.
  }
  return removed;
}

/** Backups of a registry storage switch (`registry-storage-<timestamp>`): only an unfinished switch needs one. */
export const REGISTRY_STORAGE_BACKUP = /^registry-storage-[0-9TZ-]+$/;
/** Backups of the foundation migrations of an update (`<ISO timestamp with - for : and .>`). */
export const FOUNDATION_MIGRATION_BACKUP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
