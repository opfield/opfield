import { createChildLogger } from '@/lib/logger.js';
import { readDisk } from '@/modules/diagnostics/diagnostics-system.js';
import type { DockerService } from './docker.service.js';

const logger = createChildLogger('OpfieldHostDisks');

/** Measured at most this often: one `df` per running container of the stack. */
const REFRESH_MS = 10 * 60_000;
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
/** Mount points that hold no data. */
const IGNORED_DESTINATIONS = [/^\/(proc|sys|dev|run)(\/|$)/, /\.sock$/];

/** One filesystem of the Opfield host that holds Opfield data. */
export interface OpfieldHostDisk {
  /** What lives on it, e.g. "Docker data root (images, containers, volumes)" or "postgres: /var/lib/postgresql/data". */
  holds: string[];
  filesystem: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

type DockerReader = Pick<
  DockerService,
  'inspectSelf' | 'listContainersByLabel' | 'inspectContainerDetails' | 'execInContainer'
>;

interface DfLine {
  filesystem: string;
  totalKb: number;
  availKb: number;
}

/** Parses `df -kP` output: one line per argument, in order, after the header. */
export function parseDfOutput(output: string): DfLine[] {
  const lines: DfLine[] = [];
  for (const raw of output.split('\n')) {
    const fields = raw.trim().split(/\s+/);
    if (fields.length < 6 || fields[0] === 'Filesystem') continue;
    const totalKb = Number(fields[1]);
    const availKb = Number(fields[3]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(availKb) || totalKb <= 0) continue;
    lines.push({ filesystem: fields[0]!, totalKb, availKb });
  }
  return lines;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Two readings of one filesystem through different mounts (a container's root overlay and a volume on the same disk)
 * show the same size and nearly the same free space.
 */
function sameFilesystem(a: { totalBytes: number; freeBytes: number }, b: { totalBytes: number; freeBytes: number }) {
  if (a.totalBytes !== b.totalBytes) return false;
  return Math.abs(a.freeBytes - b.freeBytes) <= Math.max(a.totalBytes * 0.005, 64 * 1024 * 1024);
}

/** Adds a reading to the list, merging it into the filesystem it belongs to. */
export function mergeDisk(disks: OpfieldHostDisk[], reading: Omit<OpfieldHostDisk, 'usedPercent'>): void {
  const existing = disks.find((disk) => sameFilesystem(disk, reading));
  if (existing) {
    for (const item of reading.holds) if (!existing.holds.includes(item)) existing.holds.push(item);
    existing.freeBytes = Math.min(existing.freeBytes, reading.freeBytes);
    existing.usedPercent = round(((existing.totalBytes - existing.freeBytes) / existing.totalBytes) * 100);
    return;
  }
  disks.push({
    ...reading,
    holds: [...reading.holds],
    usedPercent: round(((reading.totalBytes - reading.freeBytes) / reading.totalBytes) * 100),
  });
}

/**
 * Every filesystem of the Opfield host that holds Opfield data: the Docker data root (images, container layers and
 * logs, named volumes: Postgres, Redis, registry, ClickHouse, inference core) and every volume or bind of the Compose
 * stack on a disk of its own. Read with `df` inside the running stack containers, since the app itself sees only its
 * own data directory.
 */
export class OpfieldHostDiskReader {
  private cached: { at: number; disks: OpfieldHostDisk[] } | null = null;
  private inflight: Promise<OpfieldHostDisk[]> | null = null;

  constructor(
    private readonly docker: DockerReader,
    private readonly ownDataPath = '/var/lib/opfield',
    private readonly refreshMs = REFRESH_MS
  ) {}

  /** The latest reading (refreshed in the background once it is older than the refresh period). */
  latest(now = Date.now()): OpfieldHostDisk[] {
    if (!this.cached || now - this.cached.at >= this.refreshMs) void this.read().catch(() => undefined);
    return this.cached?.disks ?? [];
  }

  /** The fullest of the disks, or null before the first reading. */
  fullest(now = Date.now()): OpfieldHostDisk | null {
    return this.latest(now).reduce<OpfieldHostDisk | null>(
      (fullest, disk) => (!fullest || disk.usedPercent > fullest.usedPercent ? disk : fullest),
      null
    );
  }

  async read(options: { force?: boolean } = {}): Promise<OpfieldHostDisk[]> {
    if (!options.force && this.cached && Date.now() - this.cached.at < this.refreshMs) return this.cached.disks;
    this.inflight ??= this.measure()
      .then((disks) => {
        this.cached = { at: Date.now(), disks };
        return disks;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async measure(): Promise<OpfieldHostDisk[]> {
    const disks: OpfieldHostDisk[] = [];
    const own = await readDisk(this.ownDataPath);
    if (own) {
      mergeDisk(disks, {
        holds: [`Opfield data (${this.ownDataPath})`],
        filesystem: this.ownDataPath,
        totalBytes: own.totalBytes,
        freeBytes: own.freeBytes,
      });
    }
    let project: string | undefined;
    try {
      project = (await this.docker.inspectSelf()).Config.Labels?.[COMPOSE_PROJECT_LABEL];
    } catch {
      project = undefined;
    }
    if (!project) return disks;
    const containers = await this.docker.listContainersByLabel(`${COMPOSE_PROJECT_LABEL}=${project}`).catch(() => []);
    for (const container of containers) {
      if (container.State !== 'running') continue;
      const service =
        container.Labels?.[COMPOSE_SERVICE_LABEL] ?? container.Names[0]?.replace(/^\//, '') ?? container.Id;
      try {
        const details = await this.docker.inspectContainerDetails(container.Id);
        const destinations = (details?.Mounts ?? [])
          .filter((mount) => mount.Type === 'volume' || mount.Type === 'bind')
          .map((mount) => mount.Destination)
          .filter((destination) => !IGNORED_DESTINATIONS.some((pattern) => pattern.test(destination)));
        const targets = ['/', ...destinations];
        const result = await this.docker.execInContainer(container.Id, ['df', '-kP', ...targets]);
        if (result.exitCode !== 0) continue;
        const lines = parseDfOutput(result.output);
        if (lines.length !== targets.length) continue;
        lines.forEach((line, index) => {
          const target = targets[index]!;
          mergeDisk(disks, {
            holds: [target === '/' ? 'Docker data root (images, containers, logs, volumes)' : `${service}: ${target}`],
            filesystem: line.filesystem,
            totalBytes: line.totalKb * 1024,
            freeBytes: line.availKb * 1024,
          });
        });
      } catch (error) {
        logger.debug('Could not measure the disks of a stack container', { service, error });
      }
    }
    return disks;
  }
}
