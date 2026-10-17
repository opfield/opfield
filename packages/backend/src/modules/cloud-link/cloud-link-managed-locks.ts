import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { CloudLinkService } from './cloud-link.service.js';

/**
 * What a managed cloud installation keeps as the cloud set it up. These locks sit on the user-facing paths (REST,
 * MCP); the system paths (enrolment file, cloud link requests, setup, restore) call the services directly. Sign-in is
 * not among them: the owner of a managed installation sets it up as on any installation.
 */
export const CLOUD_MANAGED_MESSAGES = {
  license: 'This Opfield installation is managed by the cloud; its license is managed by your Opfield account.',
} as const;

/** Whether the installation is a managed cloud VM (a process without the cloud link, such as a tool, is not). */
export async function managedByCloud(): Promise<boolean> {
  if (!container.isRegistered(CloudLinkService)) return false;
  return container.resolve(CloudLinkService).managedByCloud();
}

/** For display only: false when the cloud link cannot be read. */
export async function isCloudManaged(): Promise<boolean> {
  try {
    return await managedByCloud();
  } catch {
    return false;
  }
}

/** For display and locks: whether an agent is enrolled (managed or self-hosted); false when it cannot be read. */
export async function isCloudLinked(): Promise<boolean> {
  try {
    if (!container.isRegistered(CloudLinkService)) return false;
    return await container.resolve(CloudLinkService).isEnrolled();
  } catch {
    return false;
  }
}

/** 409 CLOUD_MANAGED with the given message on a managed installation. */
export async function assertNotCloudManaged(message: string): Promise<void> {
  if (await managedByCloud()) {
    throw new AppError(409, 'CLOUD_MANAGED', message);
  }
}
