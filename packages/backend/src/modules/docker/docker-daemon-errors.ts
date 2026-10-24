import { AppError } from '@/middleware/error-handler.js';

/**
 * A Docker daemon refusal caused by the request or by the node's state, answered as a 4xx error with a text that
 * says what to do. Null for any other daemon failure (a 502 DISPATCH_ERROR). The daemon's own words stay in the
 * message where callers match them ("No such container").
 */
export function dockerDaemonUserError(message: string): AppError | null {
  const port =
    /(?:Bind for|listen tcp\d?) \[?[0-9a-fA-F.:]*\]?:(\d+)(?: failed: port is already allocated|: bind: address already in use)/.exec(
      message
    )?.[1];
  if (port || /port is already allocated|address already in use/i.test(message)) {
    return new AppError(
      409,
      'HOST_PORT_IN_USE',
      `${port ? `Host port ${port}` : 'A host port of this container'} is already in use on this node. Choose another host port, or stop the container that uses it.`
    );
  }
  const network = /network with name (\S+) already exists/i.exec(message)?.[1];
  if (network) {
    return new AppError(
      409,
      'NAME_IN_USE',
      `A network named "${network}" already exists on this node. Choose another name, or use the existing network.`
    );
  }
  if (/no such container/i.test(message)) return new AppError(404, 'CONTAINER_NOT_FOUND', message);
  const image = /no such image: (\S+)/i.exec(message)?.[1];
  if (image || /no such image/i.test(message)) {
    return new AppError(
      409,
      'IMAGE_NOT_ON_NODE',
      `${image ? `Image ${image}` : 'The image'} is not on this node (No such image). Pull it to the node first, or select its registry so Opfield pulls it when it creates the container.`
    );
  }
  if (/disk-image volumes are not supported on this node/i.test(message)) {
    return new AppError(
      409,
      'DISK_IMAGE_VOLUMES_UNSUPPORTED',
      'This node cannot create disk-image volumes: it has no loop devices (an LXC container without /dev/loop*, for one). Create a regular volume here, or a disk-image volume on another node.'
    );
  }
  return null;
}
