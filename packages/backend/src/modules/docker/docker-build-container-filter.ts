import { and, eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerSourceBindings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * The Git source whose builds a `containerName` build filter means: the source of the container of that name on the
 * node, a container its first build has not created yet included (its builds exist before the container does).
 * Null when the container has no Git source, so the filter matches no build. Container names are per node, so the
 * filter needs `nodeId`.
 */
export async function containerBuildSourceBindingId(
  nodeId: string | undefined,
  containerName: string,
  db: DrizzleClient = container.resolve<DrizzleClient>(TOKENS.DrizzleClient)
): Promise<string | null> {
  if (!nodeId) {
    throw new AppError(400, 'NODE_ID_REQUIRED', 'Filtering builds by containerName needs the nodeId of the container');
  }
  const [binding] = await db
    .select({ id: dockerSourceBindings.id })
    .from(dockerSourceBindings)
    .where(
      and(
        eq(dockerSourceBindings.targetKind, 'container'),
        eq(dockerSourceBindings.nodeId, nodeId),
        eq(dockerSourceBindings.containerName, containerName)
      )
    )
    .limit(1);
  return binding?.id ?? null;
}
