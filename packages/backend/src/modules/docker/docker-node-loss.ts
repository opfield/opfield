import { createChildLogger } from '@/lib/logger.js';
import { isNodeConnectionError } from '@/lib/node-connection-error.js';
import { AppError } from '@/middleware/error-handler.js';

const logger = createChildLogger('DockerNodeLoss');

/**
 * What became of a container operation's task when the node was lost (see noteNodeLoss): `answer-lost`, the operation
 * was sent and its task is left to be settled with the node; `failed`, its task was failed.
 */
interface DockerNodeLoss {
  kind: 'answer-lost' | 'failed';
  taskId?: string;
}

const NODE_LOSS = Symbol.for('opfield.docker.nodeLoss');

/**
 * Records on a node connection error what became of the operation's task. The error itself (its message, which the
 * commercial core and internal rollouts match on) is unchanged; nodeLossHttpError reads the record for API callers.
 */
export function noteNodeLoss<T>(error: T, loss: DockerNodeLoss): T {
  if (error instanceof Error && isNodeConnectionError(error)) {
    Object.defineProperty(error, NODE_LOSS, { value: loss, enumerable: false, configurable: true });
  }
  return error;
}

/**
 * The API answer for a container operation the node was lost during, or null for any other error:
 * - sent, its answer lost (the task is settled with the node): 504 NODE_ANSWER_LOST with the task;
 * - lost while it was sent, its task failed: 503 NODE_UNAVAILABLE with the task;
 * - lost before anything was sent: 503 NODE_UNAVAILABLE, nothing was changed; `recordFailedTask` records it as a
 *   failed task and returns its ID.
 */
export async function nodeLossHttpError(
  error: unknown,
  operation: string,
  recordFailedTask?: (message: string) => Promise<string | undefined>
): Promise<AppError | null> {
  if (!isNodeConnectionError(error)) return null;
  const loss = (error as { [NODE_LOSS]?: DockerNodeLoss })[NODE_LOSS];
  if (loss?.kind === 'answer-lost' && loss.taskId) {
    return new AppError(
      504,
      'NODE_ANSWER_LOST',
      `The node did not answer the ${operation}; it may still run there. Opfield settles task ${loss.taskId} with the node once it is connected again.`,
      { taskId: loss.taskId }
    );
  }
  if (loss?.kind === 'failed') {
    return new AppError(
      503,
      'NODE_UNAVAILABLE',
      `The node lost its connection while the ${operation} was sent: ${error instanceof Error ? error.message : String(error)}`,
      loss.taskId ? { taskId: loss.taskId } : undefined
    );
  }
  const message = `The node lost its connection before the ${operation} was sent; the container was not changed`;
  let taskId: string | undefined;
  try {
    taskId = await recordFailedTask?.(message);
  } catch (recordError) {
    logger.warn('Could not record an operation the node was lost before', {
      operation,
      error: recordError instanceof Error ? recordError.message : String(recordError),
    });
  }
  return new AppError(503, 'NODE_UNAVAILABLE', `${message}. Try again once the node is online.`, {
    ...(taskId ? { taskId } : {}),
  });
}

/** Runs a container operation for an API caller (route or AI/MCP tool), answering node loss with nodeLossHttpError. */
export async function withNodeLossAnswer<T>(
  operation: string,
  run: () => Promise<T>,
  recordFailedTask?: (message: string) => Promise<string | undefined>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw (await nodeLossHttpError(error, operation, recordFailedTask)) ?? error;
  }
}
