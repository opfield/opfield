import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerWebhooks } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import {
  type AutomaticDeployAuthority,
  resolveAutomaticDeployAuthority,
  webhookDeployMountsRefusal,
} from './automatic-deploy-authority.js';
import type { DockerManagementService } from './docker.service.js';
import type { DockerDeploymentService } from './docker-deployment.service.js';
import { envListToMap, normalizeEnvRecord } from './docker-env-operations.js';
import type { DockerImageCleanupService } from './docker-image-cleanup.service.js';
import type { DockerRegistryService } from './docker-registry.service.js';
import type { DockerTaskService } from './docker-task.service.js';
import { hashWebhookToken, issueWebhookToken, presentWebhook, WEBHOOK_TOKEN_RE } from './docker-webhook-token.js';

const logger = createChildLogger('DockerWebhookService');

export class DockerWebhookService {
  private eventBus?: EventBusService;

  constructor(
    private db: DrizzleClient,
    private docker: DockerManagementService,
    private tasks: DockerTaskService,
    private audit: AuditService,
    private dispatch: NodeDispatchService,
    private registry: DockerRegistryService,
    private cleanup: DockerImageCleanupService,
    private deployments?: DockerDeploymentService,
    /** Reads the current permissions of the account a webhook call acts for (the one that last saved the webhook). */
    private auth?: Pick<AuthService, 'getUserById'>
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  // ─── Config CRUD ──────────────────────────────────────────────────

  async getByContainer(nodeId: string, containerName: string) {
    const [row] = await this.db
      .select()
      .from(dockerWebhooks)
      .where(
        and(
          eq(dockerWebhooks.nodeId, nodeId),
          eq(dockerWebhooks.containerName, containerName),
          eq(dockerWebhooks.targetType, 'container')
        )
      )
      .limit(1);
    return row ? presentWebhook(row) : null;
  }

  async getByToken(token: string) {
    // Reject malformed bearer values before PostgreSQL sees them so database
    // parameter/error logs never receive the raw secret path segment.
    if (!WEBHOOK_TOKEN_RE.test(token)) return null;
    const tokenHash = hashWebhookToken(token);
    const [row] = await this.db.select().from(dockerWebhooks).where(eq(dockerWebhooks.tokenHash, tokenHash)).limit(1);
    if (row) return presentWebhook(row);
    // A webhook written by a path that does not hash (the token column default) is matched once and hashed here.
    const [legacy] = await this.db
      .select()
      .from(dockerWebhooks)
      .where(eq(dockerWebhooks.token, token.toLowerCase()))
      .limit(1);
    if (!legacy) return null;
    await this.db
      .update(dockerWebhooks)
      .set({ tokenHash, token: null })
      .where(and(eq(dockerWebhooks.id, legacy.id), eq(dockerWebhooks.token, token.toLowerCase())));
    return presentWebhook(legacy);
  }

  /**
   * The response of a call that created or rotated a webhook through another service (deployment webhooks): hashes the
   * plaintext token that service wrote, and returns the row with the token shown once. A row that carries no plaintext
   * token (an enabled webhook saved again) comes back with `token: null`.
   */
  async sealIssuedToken<T extends { id: string; token?: string | null; tokenHash?: string | null }>(row: T) {
    const token = row.token ?? null;
    if (token) {
      await this.db
        .update(dockerWebhooks)
        .set({ tokenHash: hashWebhookToken(token), token: null })
        .where(eq(dockerWebhooks.id, row.id));
    }
    return presentWebhook(row, token);
  }

  async getByDeployment(deploymentId: string) {
    const [row] = await this.db
      .select()
      .from(dockerWebhooks)
      .where(and(eq(dockerWebhooks.deploymentId, deploymentId), eq(dockerWebhooks.targetType, 'deployment')))
      .limit(1);
    return row ? presentWebhook(row) : null;
  }

  async upsert(nodeId: string, containerName: string, input: { enabled?: boolean }, userId: string) {
    const existing = await this.getByContainer(nodeId, containerName);
    if (existing) {
      const [updated] = await this.db
        .update(dockerWebhooks)
        .set({
          enabled: input.enabled ?? existing.enabled,
          // Saving the webhook makes this account the one its calls act for.
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(eq(dockerWebhooks.id, existing.id))
        .returning();
      this.emit('updated', updated);
      return presentWebhook(updated);
    }

    // The URL is shown once, in this response; only its hash is stored.
    const issued = issueWebhookToken();
    const [created] = await this.db
      .insert(dockerWebhooks)
      .values({
        nodeId,
        containerName,
        targetType: 'container',
        token: null,
        tokenHash: issued.tokenHash,
        enabled: input.enabled ?? true,
        createdById: userId,
        updatedById: userId,
      })
      .returning();

    await this.audit.log({
      action: 'docker.webhook.created',
      userId,
      resourceType: 'docker-webhook',
      resourceId: created.id,
      details: { nodeId, containerName },
    });
    this.emit('created', created);
    return presentWebhook(created, issued.token);
  }

  async remove(nodeId: string, containerName: string, userId: string) {
    const existing = await this.getByContainer(nodeId, containerName);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');

    await this.db.delete(dockerWebhooks).where(eq(dockerWebhooks.id, existing.id));

    await this.audit.log({
      action: 'docker.webhook.deleted',
      userId,
      resourceType: 'docker-webhook',
      resourceId: existing.id,
      details: { nodeId, containerName },
    });
    this.emit('deleted', existing);
  }

  async regenerateToken(nodeId: string, containerName: string, userId: string) {
    const existing = await this.getByContainer(nodeId, containerName);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');

    const issued = issueWebhookToken();
    const [updated] = await this.db
      .update(dockerWebhooks)
      .set({ token: null, tokenHash: issued.tokenHash, updatedById: userId, updatedAt: new Date() })
      .where(eq(dockerWebhooks.id, existing.id))
      .returning();

    await this.audit.log({
      action: 'docker.webhook.regenerated',
      userId,
      resourceType: 'docker-webhook',
      resourceId: existing.id,
      details: { nodeId, containerName },
    });
    this.emit('updated', updated);
    return presentWebhook(updated, issued.token);
  }

  // ─── Core update action ───────────────────────────────────────────

  async triggerUpdate(params: {
    nodeId: string;
    containerName: string;
    containerId: string;
    tag?: string;
    userId?: string;
    webhookId?: string;
    /**
     * With `webhookId`: the account that last saved the webhook (`docker_webhooks.updated_by_id`). A webhook call acts
     * for it, so a new image on a container with host bind mounts needs its current docker:containers:mounts. Left
     * out or null, no account can authorize that and such a call is refused.
     */
    webhookOwnerId?: string | null;
  }): Promise<{ taskId: string; message: string }> {
    const managed = await this.docker.getManagedContainerConfiguration(params.nodeId, params.containerId);
    const { tag, userId, webhookId } = params;
    const nodeId = managed?.nodeId ?? params.nodeId;
    const containerName = managed?.containerName ?? params.containerName;
    const containerId = managed?.containerName ?? params.containerId;

    // HA uses the canonical source image; replica snapshots contain mirror
    // references and projected environment/secrets, not editable configuration.
    const inspectData = managed ? null : await this.docker.inspectContainer(nodeId, containerId);
    const currentImage: string = managed?.image ?? (inspectData as any)?.Config?.Image ?? '';
    if (!currentImage) {
      throw new AppError(400, 'NO_IMAGE', 'Cannot determine current container image');
    }

    const { imageName, currentTag } = parseImageRef(managed ? currentImage.split('@')[0]! : currentImage);
    const targetTag = tag ?? currentTag;
    const targetRef =
      managed && tag === undefined && currentImage.includes('@') ? currentImage : `${imageName}:${targetTag}`;

    // Check container is not busy
    this.docker.requireNoTransition(nodeId, containerName);

    // Create task for tracking
    const task = await this.tasks.create({
      nodeId,
      containerId,
      containerName,
      type: 'webhook_update',
    });
    await this.tasks.update(task.id, {
      status: 'running',
      progress: managed ? `Rolling out ${targetRef}...` : `Pulling ${targetRef}...`,
    });

    // Set transition and broadcast to frontend
    this.docker.setTransition(nodeId, containerName, 'updating');
    this.docker.emitTransition(nodeId, containerName, containerId, 'updating');

    try {
      if (!managed) {
        // Synchronous pull — validates the image exists
        const registryAuthCandidates = await this.registry.resolveAuthCandidatesForImagePull(nodeId, targetRef);
        const registryAttempts = registryAuthCandidates.length ? registryAuthCandidates : [null];
        for (const registryAuth of registryAttempts) {
          const pullPayload: { imageRef: string; registryAuthJson?: string } = { imageRef: targetRef };
          if (registryAuth) {
            pullPayload.registryAuthJson = registryAuth.authJson;
          }

          const pullResult = await this.dispatch.sendDockerImageCommand(nodeId, 'pull', pullPayload, 600000);
          if (pullResult.success) {
            await this.registry.rememberImageRegistry(nodeId, targetRef, registryAuth?.registryId);
            break;
          }
          if (registryAuth === registryAttempts.at(-1) || !isRegistryRetryablePullError(pullResult.error)) {
            throw new AppError(400, 'PULL_FAILED', pullResult.error || `Failed to pull ${targetRef}`);
          }
        }
      }
    } catch (err) {
      this.docker.clearTransition(nodeId, containerName);
      await this.tasks
        .update(task.id, {
          status: 'failed',
          error: err instanceof AppError ? err.message : err instanceof Error ? err.message : 'Pull failed',
          completedAt: new Date(),
        })
        .catch(() => {});
      throw err;
    }

    // Clear our transition — recreateWithConfig will set 'recreating'
    this.docker.clearTransition(nodeId, containerName);

    let authority: AutomaticDeployAuthority | null = null;
    try {
      if (managed) {
        // The coordinator merges this image-only patch, preserves shouldRun and
        // runtime/security settings, and resolves only after the rollout finishes.
        await this.docker.recreateWithConfig(nodeId, containerId, { image: targetRef }, userId ?? null, {
          waitForAvailability: true,
          forceAvailabilityRollout: true,
        });
      } else {
        const config = buildRecreateConfig(inspectData as Record<string, unknown>, targetRef);
        // A webhook call acts for the account that last saved the webhook. The mount guard asks for its scopes only
        // when the container has host bind mounts; Availability containers have no mounts at all.
        authority = webhookId
          ? await resolveAutomaticDeployAuthority(this.auth, { updatedById: params.webhookOwnerId })
          : null;
        await this.docker.recreateWithConfig(nodeId, containerId, config, userId ?? null, {
          skipImagePull: true,
          skipWebhookCleanup: true,
          ...(authority ? { actorScopes: authority.scopes } : {}),
        });
      }
    } catch (caught) {
      const workload = `container "${containerName}"`;
      const err =
        (authority
          ? webhookDeployMountsRefusal(caught, authority, workload, 'update')
          : webhookHostBindRefusal(caught, workload)) ?? caught;
      await this.tasks
        .update(task.id, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Recreate failed',
          completedAt: new Date(),
        })
        .catch(() => {});
      throw err;
    }

    // Mark our tracking task as succeeded (recreateWithConfig has its own task for the recreate itself)
    await this.tasks
      .update(task.id, {
        status: 'succeeded',
        progress: `Updated to ${targetRef}`,
        completedAt: new Date(),
      })
      .catch(() => {});

    // Audit
    await this.audit
      .log({
        action: 'docker.webhook.triggered',
        userId: userId ?? null,
        resourceType: 'docker-container',
        resourceId: containerId,
        details: {
          nodeId,
          containerName,
          from: currentImage,
          to: targetRef,
          source: webhookId ? 'webhook' : 'manual',
        },
      })
      .catch(() => {});

    if (!managed) this.cleanup.scheduleCleanupForContainer(nodeId, containerName, imageName).catch(() => {});

    const message = `Updating ${containerName} to ${targetRef}`;
    logger.info(message, { nodeId, containerId, webhookId });
    return { taskId: task.id, message };
  }

  async triggerWebhookToken(token: string, tag?: string, userId?: string) {
    const webhook = await this.getByToken(token);
    if (!webhook?.enabled) {
      throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
    }
    if (webhook.targetType === 'deployment') {
      if (!this.deployments) throw new AppError(500, 'DEPLOYMENTS_UNAVAILABLE', 'Deployment service unavailable');
      // The deployment acts for the account that last saved the webhook, read from its current permissions.
      const authority = await resolveAutomaticDeployAuthority(this.auth, { updatedById: webhook.updatedById });
      return this.deployments.triggerWebhook(webhook.id, tag, authority);
    }
    return this.triggerUpdate({
      nodeId: webhook.nodeId,
      containerName: webhook.containerName,
      containerId: webhook.containerName,
      tag,
      userId,
      webhookId: webhook.id,
      webhookOwnerId: webhook.updatedById,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private emit(action: string, data: Record<string, unknown>) {
    const { token: _token, tokenHash: _tokenHash, ...safeData } = data;
    this.eventBus?.publish('docker.webhook.changed', { ...safeData, action });
  }
}

// ─── Module-level helpers ────────────────────────────────────────────

/**
 * An image update that acts for no account cannot give a workload with host bind mounts a new image: that runs new
 * code with the host access and needs docker:containers:mounts. The refusal names the scope and the way out. Webhook
 * calls act for the account that last saved the webhook instead (`webhookDeployMountsRefusal`).
 */
export function webhookHostBindRefusal(error: unknown, workload: string): AppError | null {
  if ((error as { code?: unknown } | null)?.code !== 'MISSING_DOCKER_MOUNTS_SCOPE') return null;
  return new AppError(
    403,
    'MISSING_DOCKER_MOUNTS_SCOPE',
    `Image update refused: ${workload} has host bind mounts, so running a new image on it needs docker:containers:mounts, and this update acts for no account that holds it. Update the image as a user who holds docker:containers:mounts on it.`
  );
}

/** Parse "image:tag" into components. Handles images with registry prefixes. */
function parseImageRef(ref: string): { imageName: string; currentTag: string } {
  // Handle refs like "registry.com/repo:tag", "repo:tag", "repo" (defaults to latest)
  const lastColon = ref.lastIndexOf(':');
  // Check if the colon is part of a port number (e.g., registry.com:5000/repo)
  const lastSlash = ref.lastIndexOf('/');
  if (lastColon === -1 || lastSlash > lastColon) {
    return { imageName: ref, currentTag: 'latest' };
  }
  return { imageName: ref.slice(0, lastColon), currentTag: ref.slice(lastColon + 1) };
}

function isRegistryRetryablePullError(error?: string): boolean {
  return /pull access denied|repository does not exist|insufficient_scope|authorization|authentication|no basic auth|denied/i.test(
    error ?? ''
  );
}

/** Build a recreate config from inspect data, overriding the image. */
function buildRecreateConfig(inspect: Record<string, unknown>, newImage: string): Record<string, unknown> {
  const config = (inspect as any)?.Config ?? {};
  const hostConfig = (inspect as any)?.HostConfig ?? {};
  const networkingConfig = (inspect as any)?.NetworkingConfig ?? {};
  const env = Array.isArray(config.Env)
    ? envListToMap(config.Env.filter((entry: unknown): entry is string => typeof entry === 'string'))
    : normalizeEnvRecord(config.Env);

  const recreateConfig: Record<string, unknown> = {
    image: newImage,
    cmd: config.Cmd,
    entrypoint: config.Entrypoint,
    workingDir: config.WorkingDir,
    user: config.User,
    hostname: config.Hostname,
    labels: config.Labels,
    exposedPorts: config.ExposedPorts,
    hostConfig,
    networkingConfig,
  };
  if (env) {
    recreateConfig.env = env;
  }
  return recreateConfig;
}
