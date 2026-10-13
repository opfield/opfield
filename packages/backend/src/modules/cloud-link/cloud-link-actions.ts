import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { RELEASE_VERSION_PATTERN } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { enrollmentInstallation, publicUrlFallbackOpfield } from '@/modules/nodes/node-installer.js';
import { CreateNodeSchema } from '@/modules/nodes/nodes.schemas.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { SetupAccessService } from '@/modules/setup/setup-access.service.js';
import { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { UpdateService } from '@/services/update.service.js';
import { CloudLinkService } from './cloud-link.service.js';
import {
  CLOUD_NODE_KINDS,
  type CloudLinkActions,
  DEFAULT_RELAY_SERVICE_PORT,
  resolveCloudNodeKind,
} from './cloud-link.types.js';
import { createCloudSsoClient } from './cloud-link-sso-client.js';
import { createCloudSsoRevoker } from './cloud-link-sso-revoke.js';

const logger = createChildLogger('CloudLinkActions');

/** The actor Opfield records for what the cloud account does over the link (not a user account). */
export const CLOUD_LINK_ACTOR = 'cloud-link';
const DEFAULT_NODE_NAME = 'Node';
const MAX_NODE_NAME_LENGTH = 255;

/**
 * What the cloud account may do over the link besides reading, each the same mechanism the product already has:
 * the first-admin setup code of setup-code.js, Nodes → Add node, the Update now of Settings, and the client and
 * client secret of the Opfield account sign-in.
 */
export function createCloudLinkActions(): CloudLinkActions {
  return {
    async setupLink() {
      const policy = container.resolve(SetupTokenPolicyService);
      if ((await policy.isSetupComplete()) || (await policy.isOpfieldConfigured())) throw new Error('already set up');
      const generated = await container.resolve(SetupAccessService).generateCode();
      return { code: generated.code, expiresAt: generated.expiresAt };
    },

    async nodeToken(options) {
      const kind = resolveCloudNodeKind(options.kind);
      if (!kind) throw new Error(`Unknown node kind; use one of ${CLOUD_NODE_KINDS.join(', ')}`);
      const displayName = options.name?.trim().slice(0, MAX_NODE_NAME_LENGTH) || DEFAULT_NODE_NAME;
      // As Nodes → Add node creates it: pending at the root, enrolled by its setup command; a relay also advertises
      // its address and port.
      const input = CreateNodeSchema.parse({
        type: kind,
        hostname: 'pending',
        displayName,
        folderId: null,
        ...(kind === 'relay'
          ? {
              serviceAddresses: [options.address?.trim() ?? ''],
              servicePort: options.port ?? DEFAULT_RELAY_SERVICE_PORT,
            }
          : {}),
      });
      const created = await container.resolve(NodesService).create(input, CLOUD_LINK_ACTOR);
      const installation = await enrollmentInstallation(created, await publicUrlFallbackOpfield());
      const target =
        installation.installCommands.find((command) => command.target === 'public') ?? installation.installCommands[0];
      if (!target) throw new Error('Opfield has no address a node could enrol with; set its public URL first');
      return {
        token: created.enrollmentToken,
        expiresAt: created.enrollmentTokenExpiresAt,
        command: target.curl,
        nodeId: created.node.id,
        kind,
      };
    },

    async updateStatus() {
      const updateService = container.resolve(UpdateService);
      const status = await updateService.getCachedStatus();
      const channel = (await container.resolve(GeneralSettingsService).getConfig()).updateChannel ?? 'stable';
      const operation = status.opfieldOperation;
      return {
        current: status.currentVersion,
        latest: status.latestVersion,
        channel,
        available: status.updateAvailable,
        updating:
          updateService.isOpfieldUpdateInProgress() ||
          operation?.status === 'updating' ||
          operation?.status === 'waiting_for_operations',
      };
    },

    // The account portal rotated the client of the Opfield account sign-in: stored encrypted, used at the next sign-in
    // on every replica (the discovery cache follows the stored client). Refused with OPFIELD_ACCOUNT_PROVIDER_MISSING
    // and nothing changed when the admin removed that provider or chose another client; the portal keeps the old
    // secret then.
    async ssoSecret(clientSecret) {
      const oidcSettings = container.resolve(OidcSettingsService);
      // A self-hosted installation takes it only for a client the account gave it (Use Opfield account for sign-in).
      if (
        !(await container.resolve(CloudLinkService).managedByCloud()) &&
        !(await oidcSettings.hasKeptOpfieldAccountClient())
      ) {
        throw new AppError(
          409,
          'OPFIELD_ACCOUNT_PROVIDER_MISSING',
          'Opfield Cloud gave this installation no sign-in client; the new client secret was not stored'
        );
      }
      await oidcSettings.rotateOpfieldAccountSecret(clientSecret);
      container.resolve(AuthService).invalidateOidcConfiguration();
      await container.resolve(CloudLinkService).recordManagedSso({ step: 'secret_rotated', source: 'cloud-link' });
      return { saved: true };
    },

    // The client the account created after Use Opfield account for sign-in asked for one (see CloudSsoClient).
    async ssoClient(client) {
      return createCloudSsoClient().accept(client);
    },

    // The account removed people's access: their accounts are blocked as the Opfield account's (see CloudSsoRevoker).
    async ssoRevoke(input) {
      return createCloudSsoRevoker().revoke(input);
    },

    // Mirrors POST /api/system/update (Settings → Update now).
    async update(version) {
      const updateService = container.resolve(UpdateService);
      if (updateService.isOpfieldUpdateInProgress()) {
        throw new AppError(409, 'UPDATE_IN_PROGRESS', 'An Opfield update is already in progress');
      }
      await updateService.assertOpfieldUpdateAllowed();
      const status = await updateService.getCachedStatus();
      if (!status.updateAvailable || !status.latestVersion) throw new Error('No update available');
      const target = version?.trim() || status.latestVersion;
      if (!RELEASE_VERSION_PATTERN.test(target)) throw new Error('Invalid version format');
      if (target !== status.latestVersion) throw new Error('Requested version does not match available update');
      const artifact = await updateService.prepareOpfieldUpdate(target);
      // A new attempt supersedes the report of a previous rolled-back one.
      await updateService.acknowledgeOpfieldUpdateFailure();
      const eventBus = container.resolve(EventBusService);
      eventBus.publish('system.update.changed', { updating: true, component: 'opfield', targetVersion: target });
      // Answer first: the update replaces this container.
      setTimeout(() => {
        updateService.performUpdate(target, artifact, null).catch((error) => {
          if (error instanceof AppError && error.code === 'UPDATE_IN_PROGRESS') return;
          eventBus.publish('system.update.changed', {
            updating: false,
            component: 'opfield',
            targetVersion: target,
            ...(error instanceof AppError ? { error: error.message } : {}),
          });
          logger.error('Opfield update started by the cloud account failed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        });
      }, 500);
      return { started: true, version: target };
    },
  };
}
