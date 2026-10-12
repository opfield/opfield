import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseProcessStartSeconds, readHostCgroup, readHostUptimeSeconds, readProcFile } from './diagnostics-system.js';

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

// Readings of a Proxmox LXC (CT 1130): its cgroup root, its init's /proc/1/stat and the kernel's /proc/uptime.
const LXC_MEMORY_STAT = [
  'anon 1168265216',
  'file 327864320',
  'shmem 82587648',
  'active_anon 1250725888',
  'inactive_file 8196096',
  'active_file 237137920',
  'slab_reclaimable 68548216',
  'slab_unreclaimable 114656088',
  '',
].join('\n');
const LXC_INIT_STAT =
  '1 (systemd) S 0 1 1 0 -1 4194560 23861 1316440 64 1145 147 103 8270 4231 20 0 1 0 293943460 ' +
  '23506944 3164 18446744073709551615 1 1 0 0 0 0 671173123 4096 1260 0 0 0 17 6 0 0 0 0 0\n';

describe('host readings in an LXC and on a bare host', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function layout(files: Record<string, string>) {
    root = await mkdtemp(path.join(os.tmpdir(), 'diag-host-'));
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    return (file: string) => path.join(root, file);
  }

  it("reads an LXC's memory use from its cgroup root as LXCFS does for free", async () => {
    const at = await layout({
      'cgroup/memory.current': '1613180928\n',
      'cgroup/memory.max': 'max\n',
      'cgroup/memory.stat': LXC_MEMORY_STAT,
      'cgroup/cpu.max': 'max 100000\n',
    });
    const reading = await readHostCgroup(at('cgroup'));
    // memory.current - active_file - inactive_file - slab_reclaimable
    expect(reading).toEqual({ memoryLimitBytes: null, memoryUsedBytes: 1299298696, cpuQuota: null });
  });

  it('reads the limit and CPU quota of an LXC when its own cgroup sets them', async () => {
    const at = await layout({
      'cgroup/memory.current': '1000\n',
      'cgroup/memory.max': '4294967296\n',
      'cgroup/memory.stat': 'active_file 100\ninactive_file 50\nslab_reclaimable 25\n',
      'cgroup/cpu.max': '250000 100000\n',
    });
    expect(await readHostCgroup(at('cgroup'))).toEqual({
      memoryLimitBytes: 4294967296,
      memoryUsedBytes: 825,
      cpuQuota: 2.5,
    });
  });

  it('treats a root cgroup (bare host or VM) or a missing mount as not an LXC', async () => {
    const at = await layout({ 'cgroup/memory.stat': LXC_MEMORY_STAT, 'cgroup/cpu.stat': 'usage_usec 1\n' });
    expect(await readHostCgroup(at('cgroup'))).toBeNull();
    expect(await readHostCgroup(at('missing'))).toBeNull();
  });

  it('parses the start of a process even when its name holds spaces and parentheses', () => {
    expect(parseProcessStartSeconds(LXC_INIT_STAT)).toBe(2939434.6);
    expect(parseProcessStartSeconds(LXC_INIT_STAT.replace('(systemd)', '(a) b (c)'))).toBe(2939434.6);
    expect(parseProcessStartSeconds('1 (init) S')).toBeNull();
  });

  it("gives an LXC's uptime from its init's start and a bare host's from the kernel", async () => {
    const at = await layout({ 'proc/1/stat': LXC_INIT_STAT, 'proc/uptime': '4022524.13 46234880.11\n' });
    const paths = { initStat: at('proc/1/stat'), kernelUptime: at('proc/uptime') };
    expect(await readHostUptimeSeconds(true, paths)).toBeCloseTo(1083089.53, 2);
    expect(await readHostUptimeSeconds(false, paths)).toBeCloseTo(4022524.13, 2);
    // Without the init mount, the kernel's uptime.
    expect(await readHostUptimeSeconds(true, { ...paths, initStat: at('proc/9/stat') })).toBeCloseTo(4022524.13, 2);
  });
});
