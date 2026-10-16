import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepTempLeftovers, TEMP_LEFTOVER_MIN_AGE_MS } from './host-temp-sweep.js';

describe('temp leftover sweep', () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it('removes only old entries with an Opfield prefix', async () => {
    root = await mkdtemp(join(tmpdir(), 'sweep-test-'));
    const now = Date.now();
    const old = new Date(now - TEMP_LEFTOVER_MIN_AGE_MS - 60_000);
    await mkdir(join(root, 'opfield-git-old'));
    await writeFile(join(root, 'opfield-git-old', 'pack'), 'x'.repeat(10));
    await utimes(join(root, 'opfield-git-old'), old, old);
    await mkdir(join(root, 'opfield-git-new'));
    await writeFile(join(root, 'other-old'), 'keep');
    await utimes(join(root, 'other-old'), old, old);
    await writeFile(join(root, 'opfield-pages-link-old'), 'pages owns it');
    await utimes(join(root, 'opfield-pages-link-old'), old, old);

    await expect(sweepTempLeftovers({ root, now, dryRun: true })).resolves.toEqual({ removed: 1, bytes: 10 });
    expect((await readdir(root)).sort()).toHaveLength(4);
    await expect(sweepTempLeftovers({ root, now })).resolves.toEqual({ removed: 1, bytes: 10 });
    expect((await readdir(root)).sort()).toEqual(['opfield-git-new', 'opfield-pages-link-old', 'other-old']);
  });
});
