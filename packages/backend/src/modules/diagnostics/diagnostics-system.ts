import { constants } from 'node:fs';
import { access, readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { type EventLoopUtilization, monitorEventLoopDelay, performance } from 'node:perf_hooks';

/**
 * Host and process readings for Gateway diagnostics. Inside the app container /proc/loadavg,
 * /proc/meminfo, /proc/stat and /proc/uptime are not namespaced, so os.* and these files describe the
 * whole kernel: in an LXC that is the hypervisor. The installer therefore mounts the host's own files:
 * - /proc/meminfo, /proc/loadavg and /proc/stat at /host/proc. In an LXC, LXCFS serves them, but per the
 *   cgroup of the process that reads them: read from the app container they describe the app container,
 *   except MemTotal (the LXC's limit), the CPU list (the LXC's) and the load (never virtualised: the
 *   hypervisor's, which we accept and label as the host's).
 * - the host's /sys/fs/cgroup at /host/cgroup. When its root is itself a cgroup (it has memory.current), the
 *   host is a container such as an LXC, and its memory use and CPU quota are read there, as LXCFS computes
 *   them for `free` inside the LXC. On a bare host or VM the root cgroup has no memory.current, and
 *   /host/proc/meminfo is the kernel's.
 * - the host's /proc/1/stat at /host/proc/1/stat: in an LXC, the uptime is the time since its init started.
 * The host reading further narrows them to what binds Gateway: the CPUs it may run on (its affinity, which
 * an LXC's cpuset sets) and the cgroup limits of its container.
 */

/** Where the installer mounts the host's /proc files (meminfo, loadavg, stat, 1/stat). */
export const HOST_PROC_DIR = '/host/proc';

/** Where the installer mounts the host's /sys/fs/cgroup. */
export const HOST_CGROUP_DIR = '/host/cgroup';

/** Clock ticks per second of /proc/<pid>/stat times: USER_HZ, 100 on every Linux architecture Gateway runs on. */
const CLOCK_TICKS_PER_SECOND = 100;

/** A /proc file of the host when it is mounted and readable, else the container's own; null when neither reads. */
export async function readProcFile(
  file: string,
  dirs: readonly string[] = [HOST_PROC_DIR, '/proc']
): Promise<{ text: string; host: boolean } | null> {
  for (const [index, dir] of dirs.entries()) {
    const path = `${dir}/${file}`;
    try {
      await access(path, constants.R_OK);
      return { text: await readFile(path, 'utf8'), host: index < dirs.length - 1 };
    } catch {
      // Not mounted or not readable: try the next directory.
    }
  }
  return null;
}

export interface HostReading {
  /** CPUs Gateway may run on: its CPU affinity (an LXC or container cpuset), capped by the CPU quotas of its container and of an LXC host. */
  cpuCount: number;
  /** CPUs of the host: the LXC's with the host /proc mounted, else the whole kernel's; can be more than cpuCount. */
  kernelCpuCount: number;
  /** Busy share of the CPUs Gateway may run on since the previous reading; null on the first reading. */
  cpuPercent: number | null;
  /** Load averages of the kernel: in an LXC the hypervisor's, which LXCFS does not virtualise by default. */
  loadAverage: [number, number, number];
  /** The 1-minute load per host CPU. */
  loadPerCpu: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  memoryUsedPercent: number;
  /**
   * `cgroup`: the memory limit of Gateway's container and its use. `kernel`: the container has no limit, so the
   * figures are the host's: in an LXC its own cgroup's (as `free` shows inside it), on a bare host or VM its
   * /proc/meminfo; without the host mounts they are the whole kernel's, in an LXC the hypervisor's.
   */
  memoryScope: 'cgroup' | 'kernel';
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
  /** Seconds since the host started: in an LXC since its init started, else since the kernel booted. */
  uptimeSeconds: number;
  kernel: string;
  /** The filesystem that holds Gateway's data, which is usually Docker's data root. */
  disk: DiskReading | null;
}

export interface DiskReading {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export interface ProcessReading {
  pid: number;
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  /** CPU time of this process against wall time since the previous reading, in percent of one CPU. */
  cpuPercent: number | null;
  eventLoop: {
    /** Share of time the event loop was busy since the previous reading. */
    utilizationPercent: number | null;
    delayP50Ms: number | null;
    delayP99Ms: number | null;
    delayMaxMs: number | null;
  };
  container: { memoryUsageBytes: number | null; memoryLimitBytes: number | null } | null;
}

interface CpuTimes {
  busy: number;
  total: number;
}

function hostCpuTimes(): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle, irq } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + idle + irq;
  }
  return { busy, total };
}

/** The CPUs this process may run on (`Cpus_allowed_list`, e.g. `0-3,8`); null off Linux. */
async function readAllowedCpus(): Promise<Set<number> | null> {
  try {
    const list = /^Cpus_allowed_list:\s*(\S+)/m.exec(await readFile('/proc/self/status', 'utf8'))?.[1];
    if (!list) return null;
    const cpus = new Set<number>();
    for (const range of list.split(',')) {
      const [from, to = from] = range.split('-').map(Number);
      if (from === undefined || !Number.isInteger(from) || !Number.isInteger(to)) return null;
      for (let cpu = from; cpu <= to; cpu++) cpus.add(cpu);
    }
    return cpus.size > 0 ? cpus : null;
  } catch {
    return null;
  }
}

/**
 * CPU times of the allowed CPUs from /proc/stat, counted as os.cpus() counts them; every CPU off Linux. LXCFS lists
 * only an LXC's CPUs, renumbered from 0, so a host /proc/stat with fewer CPUs than the kernel counts all its CPUs.
 */
async function allowedCpuTimes(
  allowed: Set<number> | null,
  stat: { text: string; host: boolean } | null,
  kernelCpuCount: number
): Promise<CpuTimes> {
  if (!allowed || !stat) return hostCpuTimes();
  const cpus = [...stat.text.matchAll(/^cpu(\d+)\s+(.+)$/gm)];
  const filter = !(stat.host && cpus.length > 0 && cpus.length < kernelCpuCount);
  try {
    let busy = 0;
    let total = 0;
    for (const match of cpus) {
      if (filter && !allowed.has(Number(match[1]))) continue;
      // user nice system idle iowait irq …
      const ticks = (match[2] ?? '').trim().split(/\s+/).map(Number);
      const [user = 0, nice = 0, sys = 0, idle = 0] = ticks;
      const irq = ticks[5] ?? 0;
      busy += user + nice + sys + irq;
      total += user + nice + sys + idle + irq;
    }
    return total > 0 ? { busy, total } : hostCpuTimes();
  } catch {
    return hostCpuTimes();
  }
}

/** /proc/meminfo in bytes; empty off Linux (a development machine), where os.freemem() stands in. */
async function readMemInfo(): Promise<Map<string, number>> {
  const values = new Map<string, number>();
  for (const line of ((await readProcFile('meminfo'))?.text ?? '').split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (match?.[1] && match[2]) values.set(match[1], Number(match[2]) * 1024);
  }
  return values;
}

/**
 * /proc/loadavg; os.loadavg() off Linux. The load is the kernel's: LXCFS virtualises it only when started with
 * `--enable-loadavg`, which Proxmox does not, so in an LXC this is the hypervisor's load.
 */
async function readLoadAverage(): Promise<number[]> {
  const values = (await readProcFile('loadavg'))?.text.trim().split(/\s+/).slice(0, 3).map(Number) ?? [];
  return values.length === 3 && values.every(Number.isFinite) ? values : os.loadavg();
}

/** Seconds since the kernel booted: the container's own /proc/uptime is not namespaced; os.uptime() off Linux. */
async function readKernelUptimeSeconds(uptimeFile: string): Promise<number> {
  try {
    const seconds = Number((await readFile(uptimeFile, 'utf8')).trim().split(/\s+/)[0]);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  } catch {
    // Not Linux: fall through.
  }
  return os.uptime();
}

/** Start of a process in seconds after the kernel booted, from its /proc/<pid>/stat (field 22, starttime). */
export function parseProcessStartSeconds(stat: string): number | null {
  // The command name (field 2) is in parentheses and may hold spaces; field 3 follows the last `)`.
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  const ticks = Number(fields[22 - 3]);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks / CLOCK_TICKS_PER_SECOND : null;
}

/**
 * Seconds since the host started. In an LXC (`nested`), LXCFS would answer /proc/uptime for the reader's
 * container, so the uptime is the kernel's uptime minus when the LXC's init started; else the kernel's.
 */
export async function readHostUptimeSeconds(
  nested: boolean,
  paths: { initStat: string; kernelUptime: string } = {
    initStat: `${HOST_PROC_DIR}/1/stat`,
    kernelUptime: '/proc/uptime',
  }
): Promise<number> {
  const kernelUptime = await readKernelUptimeSeconds(paths.kernelUptime);
  if (!nested) return kernelUptime;
  try {
    const start = parseProcessStartSeconds(await readFile(paths.initStat, 'utf8'));
    if (start !== null && start <= kernelUptime) return kernelUptime - start;
  } catch {
    // The host's init is not mounted: the kernel's uptime.
  }
  return kernelUptime;
}

/** The memory and CPU quota of a host that is itself a cgroup (an LXC), read from its mounted cgroup root. */
export interface HostCgroupReading {
  /** memory.max of the host's cgroup; null when the limit is set above it (as Proxmox does) or unlimited. */
  memoryLimitBytes: number | null;
  /** memory.current without reclaimable file cache and slab, as LXCFS computes MemAvailable for `free`. */
  memoryUsedBytes: number;
  /** cpu.max of the host's cgroup in CPUs; null without a quota. */
  cpuQuota: number | null;
}

/**
 * The host's cgroup when its root is itself a cgroup (it has memory.current, which the real root cgroup lacks):
 * the host is an LXC or similar container. Null on a bare host or VM, without cgroup v2, or without the mount.
 */
export async function readHostCgroup(dir: string = HOST_CGROUP_DIR): Promise<HostCgroupReading | null> {
  const read = async (file: string) => {
    try {
      return (await readFile(`${dir}/${file}`, 'utf8')).trim();
    } catch {
      return null;
    }
  };
  const current = Number(await read('memory.current'));
  if (!Number.isFinite(current) || current <= 0) return null;
  const stat = (await read('memory.stat')) ?? '';
  const statValue = (key: string) => Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(stat)?.[1] ?? 0);
  const reclaimable = statValue('active_file') + statValue('inactive_file') + statValue('slab_reclaimable');
  const max = await read('memory.max');
  const limit = max && max !== 'max' ? Number(max) : null;
  return {
    memoryLimitBytes: limit !== null && Number.isFinite(limit) && limit > 0 ? limit : null,
    memoryUsedBytes: Math.max(0, current - reclaimable),
    cpuQuota: parseCpuMax(await read('cpu.max')),
  };
}

/** `cpu.max` (`quota period`) in CPUs; null without a quota. */
function parseCpuMax(text: string | null): number | null {
  const [quota, period] = text?.split(/\s+/) ?? [];
  const cpus = Number(quota) / Number(period);
  return quota !== 'max' && Number.isFinite(cpus) && cpus > 0 ? cpus : null;
}

async function readCgroupText(file: string): Promise<string | null> {
  try {
    return (await readFile(`/sys/fs/cgroup/${file}`, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readCgroupNumber(file: string): Promise<number | null> {
  const text = await readCgroupText(file);
  if (!text || text === 'max') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The container's CPU quota in CPUs (`cpu.max` quota / period); null without a quota. */
async function readCgroupCpuQuota(): Promise<number | null> {
  return parseCpuMax(await readCgroupText('cpu.max'));
}

/** The container's memory limit and the memory it uses (without reclaimable inactive file cache). */
async function readCgroupMemory(): Promise<{ limitBytes: number; usedBytes: number } | null> {
  const limitBytes = await readCgroupNumber('memory.max');
  if (limitBytes === null) return null;
  const current = (await readCgroupNumber('memory.current')) ?? 0;
  const inactiveFile = Number(/^inactive_file (\d+)$/m.exec((await readCgroupText('memory.stat')) ?? '')?.[1] ?? 0);
  return { limitBytes, usedBytes: Math.max(0, current - inactiveFile) };
}

export async function readDisk(path: string): Promise<DiskReading | null> {
  try {
    const stats = await statfs(path);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    if (totalBytes <= 0) return null;
    return {
      path,
      totalBytes,
      freeBytes,
      usedPercent: round(((totalBytes - freeBytes) / totalBytes) * 100),
    };
  } catch {
    return null;
  }
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const NS_PER_MS = 1_000_000;
const LOOP_DELAY_RESOLUTION_MS = 20;

/** The histogram measures whole timer intervals; the delay is what exceeds the interval. */
function loopDelayMs(nanoseconds: number): number {
  return round(Math.max(0, nanoseconds / NS_PER_MS - LOOP_DELAY_RESOLUTION_MS));
}

/**
 * Keeps the counters that readings are measured against. Readings cover the time since the last
 * reset, which the minute sampler does, so an on-demand snapshot does not shorten its window.
 */
export class SystemReader {
  private previousHostCpu: CpuTimes | null = null;
  private previousProcessCpu: { usage: NodeJS.CpuUsage; at: bigint } | null = null;
  private previousElu: EventLoopUtilization | null = null;
  private readonly loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });

  constructor(private readonly dataPath: string) {
    this.loopDelay.enable();
  }

  stop(): void {
    this.loopDelay.disable();
  }

  /** Host readings; `reset` starts a new measurement window for the CPU share. */
  async readHost(reset: boolean): Promise<HostReading> {
    const allowedCpus = await readAllowedCpus();
    const stat = await readProcFile('stat');
    const statCpuCount = stat?.host ? [...stat.text.matchAll(/^cpu\d+\s/gm)].length : 0;
    const kernelCpuCount = statCpuCount > 0 ? statCpuCount : Math.max(1, os.cpus().length);
    const cpu = await allowedCpuTimes(allowedCpus, stat, Math.max(1, os.cpus().length));
    const previous = this.previousHostCpu;
    if (reset || !previous) this.previousHostCpu = cpu;
    const cpuPercent =
      previous && cpu.total > previous.total
        ? round(((cpu.busy - previous.busy) / (cpu.total - previous.total)) * 100)
        : null;
    const cpuQuota = await readCgroupCpuQuota();
    const hostCgroup = await readHostCgroup();
    const cpuCount = round(
      Math.min(
        allowedCpus?.size ?? os.availableParallelism(),
        kernelCpuCount,
        cpuQuota ?? Infinity,
        hostCgroup?.cpuQuota ?? Infinity
      ),
      2
    );
    const memInfo = await readMemInfo();
    // In an LXC, MemTotal of the host meminfo is the LXC's limit (LXCFS finds it above the LXC's own cgroup).
    const meminfoTotalBytes = memInfo.get('MemTotal') ?? os.totalmem();
    const hostMemoryTotalBytes = Math.min(meminfoTotalBytes, hostCgroup?.memoryLimitBytes ?? Infinity);
    const hostMemoryAvailableBytes = hostCgroup
      ? Math.min(hostMemoryTotalBytes, Math.max(0, hostMemoryTotalBytes - hostCgroup.memoryUsedBytes))
      : (memInfo.get('MemAvailable') ?? os.freemem());
    const container = await readCgroupMemory();
    const limited = container !== null && container.limitBytes < hostMemoryTotalBytes;
    const memoryTotalBytes = limited ? container.limitBytes : hostMemoryTotalBytes;
    const memoryAvailableBytes = limited
      ? Math.max(0, container.limitBytes - container.usedBytes)
      : hostMemoryAvailableBytes;
    const loadAverage = (await readLoadAverage()).map((value) => round(value, 2)) as [number, number, number];
    return {
      cpuCount,
      kernelCpuCount,
      cpuPercent,
      loadAverage,
      loadPerCpu: round(loadAverage[0] / kernelCpuCount, 2),
      memoryTotalBytes,
      memoryAvailableBytes,
      memoryUsedPercent: round(((memoryTotalBytes - memoryAvailableBytes) / memoryTotalBytes) * 100),
      memoryScope: limited ? 'cgroup' : 'kernel',
      swapTotalBytes: memInfo.get('SwapTotal') ?? null,
      swapFreeBytes: memInfo.get('SwapFree') ?? null,
      uptimeSeconds: Math.round(await readHostUptimeSeconds(hostCgroup !== null)),
      kernel: `${os.type()} ${os.release()}`,
      disk: await readDisk(this.dataPath),
    };
  }

  /** Process readings; `reset` starts a new measurement window for the event-loop delay. */
  async readProcess(reset: boolean): Promise<ProcessReading> {
    const memory = process.memoryUsage();
    const now = process.hrtime.bigint();
    const usage = process.cpuUsage();
    const previous = this.previousProcessCpu;
    const elapsedMicros = previous ? Number(now - previous.at) / 1000 : 0;
    const cpuPercent =
      previous && elapsedMicros > 0
        ? round(((usage.user - previous.usage.user + usage.system - previous.usage.system) / elapsedMicros) * 100)
        : null;
    const elu = performance.eventLoopUtilization();
    const eluDelta = this.previousElu ? performance.eventLoopUtilization(elu, this.previousElu) : null;
    const delaySamples = this.loopDelay.count > 0;
    const reading: ProcessReading = {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      cpuPercent,
      eventLoop: {
        utilizationPercent: eluDelta ? round(eluDelta.utilization * 100) : null,
        delayP50Ms: delaySamples ? loopDelayMs(this.loopDelay.percentile(50)) : null,
        delayP99Ms: delaySamples ? loopDelayMs(this.loopDelay.percentile(99)) : null,
        delayMaxMs: delaySamples ? loopDelayMs(this.loopDelay.max) : null,
      },
      container: await this.readContainerMemory(),
    };
    if (reset) {
      this.previousProcessCpu = { usage, at: now };
      this.previousElu = elu;
      this.loopDelay.reset();
    } else if (!previous) {
      this.previousProcessCpu = { usage, at: now };
      this.previousElu = elu;
    }
    return reading;
  }

  private async readContainerMemory(): Promise<ProcessReading['container']> {
    const [memoryUsageBytes, memoryLimitBytes] = await Promise.all([
      readCgroupNumber('memory.current'),
      readCgroupNumber('memory.max'),
    ]);
    if (memoryUsageBytes === null && memoryLimitBytes === null) return null;
    return { memoryUsageBytes, memoryLimitBytes };
  }
}
