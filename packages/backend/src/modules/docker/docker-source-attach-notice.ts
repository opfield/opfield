import { container } from '@/container.js';
import { DockerManagementService } from './docker.service.js';

/** What attaching a Git source to an existing container changes when its first build deploys. */
export interface DockerSourceAttachNotice {
  code: 'SOURCE_REPLACES_IMAGE';
  message: string;
  /** The image the container runs now, which the first build replaces. */
  currentImage: string | null;
  /** The ports the current image exposes (`80/tcp`); the built image may listen on others. */
  currentExposedPorts: string[];
}

export type Inspect = {
  Config?: { Image?: unknown; ExposedPorts?: Record<string, unknown> | null } | null;
  HostConfig?: { PortBindings?: Record<string, unknown> | null } | null;
} | null;

/** The notice for attaching a source to a container whose inspect is `inspect` (exported for tests). */
export function describeSourceAttachNotice(
  containerName: string,
  source: { repositoryFullPath: string; branch: string },
  inspect: Inspect
): DockerSourceAttachNotice {
  const currentImage = typeof inspect?.Config?.Image === 'string' && inspect.Config.Image ? inspect.Config.Image : null;
  const exposed = Object.keys(inspect?.Config?.ExposedPorts ?? {}).sort();
  const published = Object.keys(inspect?.HostConfig?.PortBindings ?? {}).sort();
  const ports = [...new Set([...exposed, ...published])];
  const now = currentImage ? ` (now ${currentImage}${ports.length > 0 ? `, port ${ports.join(', ')}` : ''})` : '';
  return {
    code: 'SOURCE_REPLACES_IMAGE',
    message:
      `The first build replaces the image of container "${containerName}"${now} with the image built from ${source.repositoryFullPath} (${source.branch}). ` +
      'The container keeps its name, environment, secrets, volumes, networks, port mappings and restart policy; the new image sets the command and the ports the app listens on. ' +
      'If the new image listens on another port, change the routes and port mappings that point at the old one after the deploy; the build says so when the exposed ports change.',
    currentImage,
    currentExposedPorts: ports,
  };
}

/**
 * The container an attach answer describes (REST `attachNotice`, MCP upsert), read before the source is saved so the
 * notice names what runs now: attaching a source to an existing container otherwise silently swaps what it runs on
 * the first deploy. Null when the container cannot be inspected (a pending Git source container has no image yet).
 */
export async function inspectContainerBeforeAttach(nodeId: string, containerName: string): Promise<Inspect> {
  try {
    return (await container.resolve(DockerManagementService).inspectContainer(nodeId, containerName)) as Inspect;
  } catch {
    return null;
  }
}

/** The attach notice for a container read by inspectContainerBeforeAttach; null when it could not be read. */
export function containerSourceAttachNotice(
  containerName: string,
  source: { repositoryFullPath: string; branch: string },
  inspect: Inspect
): DockerSourceAttachNotice | null {
  return inspect ? describeSourceAttachNotice(containerName, source, inspect) : null;
}
