import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FOUNDATION_MIGRATION_BACKUP, pruneBackupDirectories, REGISTRY_STORAGE_BACKUP } from './backup-retention.js';

// rc.3 stand R-O-3: every registry storage switch left a backup (with the S3 keys of its time) forever, and update
// migration backups piled up too.
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function backups(names: string[], ageDays = 0): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'backups-'));
  dirs.push(dir);
  const at = new Date(Date.now() - ageDays * 24 * 60 * 60_000);
  for (const name of names) {
    await mkdir(path.join(dir, name));
    await utimes(path.join(dir, name), at, at);
  }
  return dir;
}

describe('backup retention', () => {
  it('keeps the newest three registry storage backups and nothing else of that kind', async () => {
    const names = [1, 2, 3, 4, 5].map((n) => `registry-storage-2026-10-1${n}T01-00-00-000Z`);
    const dir = await backups([...names, 'pre-update-2026-10-01T00-00-00-000Z']);
    const removed = await pruneBackupDirectories(dir, (name) => REGISTRY_STORAGE_BACKUP.test(name), { keep: 3, maxAgeDays: 0 });
    expect(removed.sort()).toEqual(names.slice(0, 2));
    expect((await readdir(dir)).sort()).toEqual([...names.slice(2), 'pre-update-2026-10-01T00-00-00-000Z'].sort());
  });

  it('removes older migration backups only past their age', async () => {
    const names = [1, 2, 3, 4].map((n) => `2026-09-0${n}T10-00-00-000Z`);
    const fresh = await backups(names, 5);
    expect(await pruneBackupDirectories(fresh, (name) => FOUNDATION_MIGRATION_BACKUP.test(name), { keep: 3, maxAgeDays: 30 })).toEqual([]);
    const old = await backups(names, 40);
    expect(await pruneBackupDirectories(old, (name) => FOUNDATION_MIGRATION_BACKUP.test(name), { keep: 3, maxAgeDays: 30 })).toEqual([
      names[0],
    ]);
  });

  it('does nothing when the directory is missing', async () => {
    await expect(pruneBackupDirectories('/nonexistent/backups', () => true, { keep: 0, maxAgeDays: 0 })).resolves.toEqual([]);
  });
});
