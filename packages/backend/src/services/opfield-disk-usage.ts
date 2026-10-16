import { sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import type { RedisClient } from './cache.service.js';
import type { DockerService } from './docker.service.js';
import type { OpfieldHostDisk, OpfieldHostDiskReader } from './opfield-host-disks.js';

const logger = createChildLogger('OpfieldDiskUsage');

/** Container log sizes are measured by a short helper at most this often. */
const CONTAINER_LOG_REFRESH_MS = 10 * 60_000;
const TOP_RELATIONS = 10;

/** What Opfield's own data takes on the Opfield host, as shown at the top of Housekeeping. */
export interface OpfieldDiskUsage {
  /** Every filesystem that holds Opfield data, with its free space. */
  disks: OpfieldHostDisk[];
  postgres: {
    databaseBytes: number;
    /** The largest tables with their indexes and TOAST. */
    largestTables: Array<{ name: string; bytes: number }>;
  } | null;
  redis: { memoryBytes: number; aofBytes: number | null; rdbChangesSinceSave: number | null } | null;
  /** Docker logs of the containers on the Opfield host (read only: log rotation is not part of Housekeeping). */
  containerLogs: {
    totalBytes: number;
    largest: Array<{ name: string; bytes: number }>;
    measuredAt: string;
  } | null;
}

type DockerHost = Pick<DockerService, 'getDaemonInfo' | 'inspectSelf' | 'listLocalContainers' | 'runOneShot'>;

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

/** Parses `INFO` output into its fields. */
export function parseRedisInfo(info: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of info.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0 || line.startsWith('#')) continue;
    fields[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return fields;
}

/**
 * Parses `stat -c '%s %n'` lines of `<id>/<id>-json.log*` files into bytes per container id. The apparent file size,
 * as nginx logs and every other size in Housekeeping count it (and as the log max-size limits it), not the blocks the
 * filesystem allocates, which on a compressing filesystem (ZFS) are a fraction of it.
 */
export function parseContainerLogSizes(output: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of output.split('\n')) {
    const match = /^(\d+)\s+\S*\/([0-9a-f]{64})\/[0-9a-f]{64}-json\.log/.exec(line.trim());
    if (!match) continue;
    sizes.set(match[2]!, (sizes.get(match[2]!) ?? 0) + Number(match[1]));
  }
  return sizes;
}

export class OpfieldDiskUsageReader {
  private containerLogs: OpfieldDiskUsage['containerLogs'] = null;
  private containerLogsAt = 0;
  private containerLogsInflight: Promise<void> | null = null;

  constructor(
    private readonly db: Pick<DrizzleClient, 'execute'>,
    private readonly docker: DockerHost,
    private readonly redis: RedisClient | null,
    private readonly disks: Pick<OpfieldHostDiskReader, 'read'> | null
  ) {}

  async read(): Promise<OpfieldDiskUsage> {
    const [disks, postgres, redis, containerLogs] = await Promise.all([
      this.disks?.read().catch(() => []) ?? Promise.resolve([]),
      this.readPostgres().catch((error) => {
        logger.debug('Could not measure the Opfield database', { error });
        return null;
      }),
      this.readRedis().catch((error) => {
        logger.debug('Could not measure Redis', { error });
        return null;
      }),
      this.readContainerLogs(),
    ]);
    return { disks, postgres, redis, containerLogs };
  }

  private async readPostgres(): Promise<OpfieldDiskUsage['postgres']> {
    const [size] = rowsOf<{ bytes: number | string }>(
      await this.db.execute(sql`SELECT pg_database_size(current_database()) AS "bytes"`)
    );
    const tables = rowsOf<{ name: string; bytes: number | string }>(
      await this.db.execute(sql`SELECT "c"."relname" AS "name", pg_total_relation_size("c"."oid") AS "bytes"
        FROM pg_class "c" JOIN pg_namespace "n" ON "n"."oid" = "c"."relnamespace"
        WHERE "c"."relkind" IN ('r', 'm') AND "n"."nspname" NOT IN ('pg_catalog', 'information_schema')
        ORDER BY pg_total_relation_size("c"."oid") DESC LIMIT ${TOP_RELATIONS}`)
    );
    return {
      databaseBytes: Number(size?.bytes ?? 0),
      largestTables: tables.map((table) => ({ name: table.name, bytes: Number(table.bytes) })),
    };
  }

  private async readRedis(): Promise<OpfieldDiskUsage['redis']> {
    if (!this.redis) return null;
    const fields = parseRedisInfo(`${await this.redis.info('memory')}\n${await this.redis.info('persistence')}`);
    const memory = Number(fields.used_memory);
    const aof = fields.aof_enabled === '1' ? Number(fields.aof_current_size) : Number.NaN;
    const changes = Number(fields.rdb_changes_since_last_save);
    return {
      memoryBytes: Number.isFinite(memory) ? memory : 0,
      aofBytes: Number.isFinite(aof) ? aof : null,
      rdbChangesSinceSave: Number.isFinite(changes) ? changes : null,
    };
  }

  /** Cached; the first call after the refresh period measures in the background and returns the previous figure. */
  private async readContainerLogs(): Promise<OpfieldDiskUsage['containerLogs']> {
    if (Date.now() - this.containerLogsAt >= CONTAINER_LOG_REFRESH_MS && !this.containerLogsInflight) {
      this.containerLogsInflight = this.measureContainerLogs()
        .catch((error: unknown) => {
          logger.debug('Could not measure container logs', { error });
        })
        .finally(() => {
          this.containerLogsAt = Date.now();
          this.containerLogsInflight = null;
        });
      // The first reading waits for the measurement, later ones show the cached figure meanwhile.
      if (!this.containerLogs) await this.containerLogsInflight;
    }
    return this.containerLogs;
  }

  private async measureContainerLogs(): Promise<void> {
    const info = await this.docker.getDaemonInfo();
    const root = info.DockerRootDir;
    if (!root) return;
    const self = await this.docker.inspectSelf();
    const result = await this.docker.runOneShot(
      {
        Image: self.Config.Image,
        User: '0',
        Entrypoint: ['sh'],
        Cmd: [
          '-c',
          "find /containers -maxdepth 2 -name '*-json.log*' -type f -exec stat -c '%s %n' {} + 2>/dev/null || true",
        ],
        HostConfig: { Binds: [`${root}/containers:/containers:ro`], NetworkMode: 'none' },
      },
      60_000
    );
    if (result.exitCode !== 0) return;
    const sizes = parseContainerLogSizes(result.output);
    const names = new Map<string, string>();
    for (const container of await this.docker.listLocalContainers()) {
      names.set(container.Id, container.Names[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12));
    }
    const entries = [...sizes.entries()]
      .map(([id, bytes]) => ({ name: names.get(id) ?? id.slice(0, 12), bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    this.containerLogs = {
      totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      largest: entries.slice(0, 10),
      measuredAt: new Date().toISOString(),
    };
  }
}
