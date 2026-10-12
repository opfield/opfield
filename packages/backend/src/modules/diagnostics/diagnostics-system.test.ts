import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProcFile } from './diagnostics-system.js';

describe('readProcFile', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function dirs() {
    root = await mkdtemp(path.join(os.tmpdir(), 'diag-proc-'));
    const host = path.join(root, 'host');
    const own = path.join(root, 'own');
    await mkdir(host);
    await mkdir(own);
    await writeFile(path.join(own, 'meminfo'), 'MemTotal: 64 kB\n');
    return { host, own };
  }

  it('prefers the host-mounted file', async () => {
    const { host, own } = await dirs();
    await writeFile(path.join(host, 'meminfo'), 'MemTotal: 8 kB\n');
    expect(await readProcFile('meminfo', [host, own])).toEqual({ text: 'MemTotal: 8 kB\n', host: true });
  });

  it("falls back to the container's own file when the host file is missing or unreadable", async () => {
    const { host, own } = await dirs();
    expect(await readProcFile('meminfo', [host, own])).toEqual({ text: 'MemTotal: 64 kB\n', host: false });
    if (process.getuid?.() !== 0) {
      await writeFile(path.join(host, 'meminfo'), 'MemTotal: 8 kB\n');
      await chmod(path.join(host, 'meminfo'), 0o000);
      expect(await readProcFile('meminfo', [host, own])).toEqual({ text: 'MemTotal: 64 kB\n', host: false });
    }
    expect(await readProcFile('loadavg', [host, own])).toBeNull();
  });
});
