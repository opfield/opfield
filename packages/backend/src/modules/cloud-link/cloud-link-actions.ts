import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { RELEASE_VERSION_PATTERN } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import { enrollmentInstallation, publicUrlFallbackGateway } from '@/modules/nodes/node-installer.js';
import { CreateNodeSchema } from '@/modules/nodes/nodes.schemas.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { SetupAccessService } from '@/modules/setup/setup-access.service.js';
import { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { UpdateService } from '@/services/update.service.js';
import type { CloudLinkActions } from './cloud-link.types.js';

const logger = createChildLogger('CloudLinkActions');

/** The actor Gateway records for what the cloud account does over the link (not a user account). */
export const CLOUD_LINK_ACTOR = 'cloud-link';
const DEFAULT_NODE_NAME = 'Node';
const MAX_NODE_NAME_LENGTH = 255;

/**
 * What the cloud account may do over the link besides reading, each the same mechanism the product already has:
 * the first-admin setup code of setup-code.js, Nodes → Add node, and the Update now of Settings.
 */
export function createCloudLinkActions(): CloudLinkActions {
  return {
    async setupLink() {
      const policy = container.resolve(SetupTokenPolicyService);
      if ((await policy.isSetupComplete()) || (await policy.isGatewayConfigured())) throw new Error('already set up');
      const generated = await container.resolve(SetupAccessService).generateCode();
      return { code: generated.code, expiresAt: generated.expiresAt };
    },

    async nodeToken(name) {
      const displayName = name?.trim().slice(0, MAX_NODE_NAME_LENGTH) || DEFAULT_NODE_NAME;
      // The defaults of Nodes → Add node: an nginx node, created pending at the root, enrolled by its setup command.
      const input = CreateNodeSchema.parse({ type: 'nginx', hostname: 'pending', displayName, folderId: null });
      const created = await container.resolve(NodesService).create(input, CLOUD_LINK_ACTOR);
      const installation = await enrollmentInstallation(created, await publicUrlFallbackGateway());
      const target =
        installation.installCommands.find((command) => command.target === 'public') ?? installation.installCommands[0];
      if (!target) throw new Error('Gateway has no address a node could enrol with; set its public URL first');
      return {
        token: created.enrollmentToken,
        expiresAt: created.enrollmentTokenExpiresAt,
        command: target.curl,
        nodeId: created.node.id,
      };
    },

    async updateStatus() {
      const updateService = container.resolve(UpdateService);
      const status = await updateService.getCachedStatus();
      const channel = (await container.resolve(GeneralSettingsService).getConfig()).updateChannel ?? 'stable';
      const operation = status.gatewayOperation;
      return {
        current: status.currentVersion,
        latest: status.latestVersion,
        channel,
        available: status.updateAvailable,
        updating:
          updateService.isGatewayUpdateInProgress() ||
          operation?.status === 'updating' ||
          operation?.status === 'waiting_for_operations',
      };
    },

    // Mirrors POST /api/system/update (Settings → Update now).
    async update(version) {
      const updateService = container.resolve(UpdateService);
      if (updateService.isGatewayUpdateInProgress()) {
        throw new AppError(409, 'UPDATE_IN_PROGRESS', 'A Gateway update is already in progress');
      }
      await updateService.assertGatewayUpdateAllowed();
      const status = await updateService.getCachedStatus();
      if (!status.updateAvailable || !status.latestVersion) throw new Error('No update available');
      const target = version?.trim() || status.latestVersion;
      if (!RELEASE_VERSION_PATTERN.test(target)) throw new Error('Invalid version format');
      if (target !== status.latestVersion) throw new Error('Requested version does not match available update');
      const artifact = await updateService.prepareGatewayUpdate(target);
      // A new attempt supersedes the report of a previous rolled-back one.
      await updateService.acknowledgeGatewayUpdateFailure();
      const eventBus = container.resolve(EventBusService);
      eventBus.publish('system.update.changed', { updating: true, component: 'gateway', targetVersion: target });
      // Answer first: the update replaces this container.
      setTimeout(() => {
        updateService.performUpdate(target, artifact, null).catch((error) => {
          if (error instanceof AppError && error.code === 'UPDATE_IN_PROGRESS') return;
          eventBus.publish('system.update.changed', {
            updating: false,
            component: 'gateway',
            targetVersion: target,
            ...(error instanceof AppError ? { error: error.message } : {}),
          });
          logger.error('Gateway update started by the cloud account failed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        });
      }, 500);
      return { started: true, version: target };
    },
  };
}
