import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerManagedVolumes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NormalizedMountDefinition } from './docker-socket-mount.guard.js';

function mountKey(mount: NormalizedMountDefinition) {
  return `${mount.type}:${mount.source}:${mount.target}:${mount.readOnly ? 'ro' : 'rw'}:${[...(mount.options ?? [])].sort().join(',')}`;
}

function describeMount(mount: NormalizedMountDefinition) {
  if (mount.type === 'bind') return `host path ${mount.source}`;
  return /^[a-f0-9]{64}$/i.test(mount.source)
    ? `anonymous volume ${mount.source.slice(0, 12)}`
    : `volume "${mount.source}"`;
}

/** A path takes one mount: Docker refuses a container with two mounts at one path ("Duplicate mount point"). */
export function assertUniqueMountTargets(mounts: NormalizedMountDefinition[]) {
  const byTarget = new Map<string, NormalizedMountDefinition>();
  for (const mount of mounts) {
    const other = byTarget.get(mount.target);
    if (other) {
      throw new AppError(
        400,
        'DOCKER_MOUNT_TARGET_DUPLICATE',
        `${describeMount(other)} and ${describeMount(mount)} both mount at ${mount.target}. A path takes one mount; keep only one of them.`
      );
    }
    byTarget.set(mount.target, mount);
  }
}

export async function assertManagedMountMutation(args: {
  db: DrizzleClient;
  dispatch: NodeDispatchService;
  parseResult(result: { success: boolean; error?: string; detail?: string }): any;
  nodeId: string;
  current: NormalizedMountDefinition[];
  next: NormalizedMountDefinition[];
}) {
  const currentKeys = new Set(args.current.map(mountKey));
  const changed = args.next.filter((mount) => !currentKeys.has(mountKey(mount)));
  // Judged on a list the request changes: the mounts a container already has are what Docker created it with.
  if (changed.length > 0) assertUniqueMountTargets(args.next);
  for (const mount of changed) {
    if (mount.type === 'bind') {
      throw new AppError(409, 'HOST_BIND_MOUNTS_DISABLED', 'New host bind mounts are not allowed');
    }
    // A host path given as a volume name is a bind mount, not a legacy volume.
    if (/^[/.~]/.test(mount.source) || mount.source.includes('/')) {
      throw new AppError(
        409,
        'HOST_BIND_MOUNTS_DISABLED',
        `"${mount.source}" is a host path. Host paths cannot be mounted; create a managed volume and mount it instead.`
      );
    }
    const [managed] = await args.db
      .select({ volumeName: dockerManagedVolumes.volumeName, storageKind: dockerManagedVolumes.storageKind })
      .from(dockerManagedVolumes)
      .where(and(eq(dockerManagedVolumes.nodeId, args.nodeId), eq(dockerManagedVolumes.volumeName, mount.source)))
      .limit(1);
    if (!managed) {
      throw new AppError(
        409,
        'MANAGED_VOLUME_REQUIRED',
        `Volume "${mount.source}" is legacy or unavailable. Migrate it from Volumes before attaching it.`
      );
    }
    const result = await args.dispatch.sendDockerVolumeCommand(args.nodeId, 'inspect', { name: mount.source });
    const volume = args.parseResult(result);
    const driver = String(volume?.Driver ?? volume?.driver ?? '');
    const scope = String(volume?.Scope ?? volume?.scope ?? '');
    const options = volume?.Options ?? volume?.options ?? {};
    // Disk images intentionally use a local bind. Only the daemon can validate
    // its device against the durable image record, including renamed volumes.
    const safeOptions =
      managed.storageKind === 'disk-image'
        ? volume?.ManagedDiskImage === true
        : options && Object.keys(options).length === 0;
    if (driver !== 'local' || scope !== 'local' || !safeOptions) {
      throw new AppError(
        409,
        'MANAGED_VOLUME_UNSAFE',
        `Volume "${mount.source}" no longer has the safe local managed-volume configuration`
      );
    }
  }
}
