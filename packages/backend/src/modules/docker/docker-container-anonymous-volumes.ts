import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { isAnonymousDockerVolumeName, isOpfieldManagedVolume } from './docker-volume-network-operations.js';

const logger = createChildLogger('DockerContainerAnonymousVolumes');

/** The anonymous volumes (an image VOLUME, a bare `-v /path`) an inspected container mounts; named ones are left out. */
export function containerAnonymousVolumes(inspect: Record<string, any> | null | undefined): string[] {
  const mounts: unknown[] = Array.isArray(inspect?.Mounts) ? inspect.Mounts : [];
  const names = mounts
    .map((mount) => mount as { Type?: unknown; Name?: unknown })
    .filter((mount) => mount.Type === 'volume' && typeof mount.Name === 'string')
    .map((mount) => mount.Name as string)
    .filter(isAnonymousDockerVolumeName);
  return [...new Set(names)];
}

/**
 * Removes the anonymous volumes of a removed container. Docker keeps them, and nothing reaches them afterwards (the
 * volume list hides anonymous volumes). A volume another container still uses stays, and so does one Gateway manages
 * (an adopted anonymous volume keeps its data); a failure never fails the container removal that already happened.
 */
export async function removeContainerAnonymousVolumes(
  ctx: {
    db: DrizzleClient;
    nodeDispatch: Pick<NodeDispatchService, 'sendDockerVolumeCommand'>;
    parseResult(result: { success: boolean; error?: string; detail?: string }): any;
  },
  nodeId: string,
  names: string[]
): Promise<void> {
  for (const name of names) {
    try {
      const volume = ctx.parseResult(await ctx.nodeDispatch.sendDockerVolumeCommand(nodeId, 'inspect', { name }));
      const usedBy = volume?.UsedBy ?? volume?.usedBy;
      if (Array.isArray(usedBy) && usedBy.length > 0) continue;
      if (await isOpfieldManagedVolume(ctx.db, nodeId, name, volume)) continue;
      // force=false: Docker still refuses a volume a container started using meanwhile.
      ctx.parseResult(await ctx.nodeDispatch.sendDockerVolumeCommand(nodeId, 'remove', { name, force: false }));
    } catch (error) {
      logger.warn('Failed to remove an anonymous volume of a removed container', {
        nodeId,
        volume: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
