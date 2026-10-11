import { ApiRequestError } from "@/services/api-base";

/** The request named a container ID the node no longer has: the container was replaced (a recreate) or removed. */
export function isContainerGoneError(error: unknown): boolean {
  return (
    error instanceof ApiRequestError && error.status === 404 && error.code === "CONTAINER_NOT_FOUND"
  );
}

/**
 * Reads a container by its ID. An ID the node no longer has may be that of a container a recreate just replaced (the
 * page learns the replacement's ID a moment later): the container is then looked up by its name once and read by the
 * replacement's ID. A container gone by its name too (or still known only by the gone ID) fails with the first error.
 */
export async function readReplacedContainer<T>(
  containerId: string,
  containerName: string | undefined,
  read: (containerId: string) => Promise<T>,
  resolveIdByName: (containerName: string) => Promise<string | undefined>
): Promise<{ containerId: string; value: T }> {
  try {
    return { containerId, value: await read(containerId) };
  } catch (error) {
    if (!containerName || !isContainerGoneError(error)) throw error;
    const replacementId = await resolveIdByName(containerName).catch(() => undefined);
    if (!replacementId || replacementId === containerId) throw error;
    return { containerId: replacementId, value: await read(replacementId) };
  }
}
