import { describe, expect, it, vi } from 'vitest';
import { LEGACY_REGISTRY_NAMESPACE } from '@/lib/legacy-compat.js';
import { assertDockerMountChangeAllowed, normalizeMountDefinitionsFromConfig } from './docker-socket-mount.guard.js';
import { DockerWebhookService } from './docker-webhook.service.js';

describe('DockerWebhookService', () => {
  it('rejects malformed bearer tokens before issuing a UUID database query', async () => {
    const select = vi.fn();
    const service = new DockerWebhookService(
      { select } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(service.getByToken('raw-secret-that-is-not-a-uuid')).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  function createService(
    inspectConfig: Record<string, unknown> = {},
    auth?: { getUserById: (id: string) => Promise<unknown> }
  ) {
    const docker = {
      getManagedContainerConfiguration: vi.fn().mockResolvedValue(null),
      inspectContainer: vi.fn().mockResolvedValue({
        Config: {
          Image: 'registry.example.com/team/app:old',
          ...inspectConfig,
        },
        HostConfig: {},
        NetworkingConfig: {},
      }),
      requireNoTransition: vi.fn(),
      setTransition: vi.fn(),
      emitTransition: vi.fn(),
      clearTransition: vi.fn(),
      recreateWithConfig: vi.fn().mockResolvedValue({}),
      listImages: vi.fn().mockResolvedValue([]),
      listContainers: vi.fn().mockResolvedValue([]),
      removeImage: vi.fn().mockResolvedValue(undefined),
    };

    const tasks = {
      create: vi.fn().mockResolvedValue({ id: 'task-1' }),
      update: vi.fn().mockResolvedValue({}),
    };

    const dispatch = {
      sendDockerImageCommand: vi.fn().mockResolvedValue({ success: true }),
    };

    const registry = {
      resolveAuthCandidatesForImagePull: vi.fn().mockResolvedValue([
        {
          registryId: 'registry-1',
          url: 'registry.example.com',
          authJson: 'encoded-auth',
        },
      ]),
      rememberImageRegistry: vi.fn().mockResolvedValue(undefined),
    };

    const cleanup = {
      scheduleCleanupForContainer: vi.fn().mockResolvedValue(undefined),
    };

    const service = new DockerWebhookService(
      {} as never,
      docker as never,
      tasks as never,
      { log: vi.fn().mockResolvedValue({}) } as never,
      dispatch as never,
      registry as never,
      cleanup as never,
      undefined,
      auth as never
    );
    const getByContainer = vi.spyOn(service, 'getByContainer').mockResolvedValue(null as never);

    return { cleanup, dispatch, docker, getByContainer, registry, service, tasks };
  }

  it.each([true, false])('updates only the canonical HA image while preserving shouldRun=%s', async (shouldRun) => {
    const { cleanup, dispatch, docker, registry, service, tasks } = createService({
      Image: `127.0.0.1:5443/${LEGACY_REGISTRY_NAMESPACE}/availability/policy:mirror`,
      Env: ['PROJECTED_SECRET=must-not-copy'],
    });
    docker.getManagedContainerConfiguration.mockResolvedValue({
      image: 'registry.example.com:5000/team/app:stable',
      nodeId: 'canonical-node',
      containerName: 'canonical-app',
      runtimeProfile: 'secure',
      shouldRun,
    });
    let finishRollout!: () => void;
    let rolloutStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      rolloutStarted = resolve;
    });
    docker.recreateWithConfig.mockImplementation(async () => {
      rolloutStarted();
      await new Promise<void>((resolve) => {
        finishRollout = resolve;
      });
      return {};
    });
    const update = service.triggerUpdate({
      nodeId: 'replica-node',
      containerId: 'replica-id',
      containerName: 'replica',
      tag: 'new',
      userId: 'actor',
    });
    await started;
    expect(tasks.update).not.toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    expect(docker.getManagedContainerConfiguration).toHaveBeenCalledWith('replica-node', 'replica-id');
    expect(docker.recreateWithConfig).toHaveBeenCalledExactlyOnceWith(
      'canonical-node',
      'canonical-app',
      { image: 'registry.example.com:5000/team/app:new' },
      'actor',
      { waitForAvailability: true, forceAvailabilityRollout: true }
    );
    expect(tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'canonical-node',
        containerId: 'canonical-app',
        containerName: 'canonical-app',
      })
    );
    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(docker.listContainers).not.toHaveBeenCalled();
    expect(dispatch.sendDockerImageCommand).not.toHaveBeenCalled();
    expect(registry.resolveAuthCandidatesForImagePull).not.toHaveBeenCalled();
    finishRollout();
    await expect(update).resolves.toMatchObject({ taskId: 'task-1' });
    expect(tasks.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    expect(cleanup.scheduleCleanupForContainer).not.toHaveBeenCalled();
  });

  it('uses the current canonical tag and reports HA rollout failures without falling back to physical mutation', async () => {
    const { cleanup, dispatch, docker, service, tasks } = createService();
    docker.getManagedContainerConfiguration.mockResolvedValue({
      image: 'registry.example.com/team/app:stable',
      nodeId: 'node-1',
      containerName: 'app',
      shouldRun: false,
    });
    docker.recreateWithConfig.mockRejectedValue(new Error('Availability rollout failed'));
    await expect(service.triggerUpdate({ nodeId: 'node-1', containerId: 'app', containerName: 'app' })).rejects.toThrow(
      'Availability rollout failed'
    );
    expect(docker.recreateWithConfig).toHaveBeenCalledWith(
      'node-1',
      'app',
      {
        image: 'registry.example.com/team/app:stable',
      },
      null,
      { waitForAvailability: true, forceAvailabilityRollout: true }
    );
    expect(tasks.update).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'failed',
        error: 'Availability rollout failed',
      })
    );
    expect(tasks.update).not.toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(dispatch.sendDockerImageCommand).not.toHaveBeenCalled();
    expect(cleanup.scheduleCleanupForContainer).not.toHaveBeenCalled();
  });

  it.each([undefined, 'next'])('handles a digest-pinned canonical HA image with tag=%s', async (tag) => {
    const { docker, service } = createService();
    const image = `registry.example.com:5000/team/app@sha256:${'a'.repeat(64)}`;
    docker.getManagedContainerConfiguration.mockResolvedValue({
      image,
      nodeId: 'node-1',
      containerName: 'app',
      shouldRun: false,
    });
    vi.spyOn(service, 'getByToken').mockResolvedValue({
      id: 'webhook-1',
      enabled: true,
      targetType: 'container',
      nodeId: 'node-1',
      containerName: 'app',
    } as never);
    await service.triggerWebhookToken('11111111-1111-4111-8111-111111111111', tag);
    expect(docker.getManagedContainerConfiguration).toHaveBeenCalledWith('node-1', 'app');
    expect(docker.recreateWithConfig).toHaveBeenCalledWith(
      'node-1',
      'app',
      {
        image: tag ? 'registry.example.com:5000/team/app:next' : image,
      },
      null,
      { waitForAvailability: true, forceAvailabilityRollout: true }
    );
    expect(docker.inspectContainer).not.toHaveBeenCalled();
  });

  it('fails closed when canonical HA configuration cannot be resolved', async () => {
    const { docker, service, tasks } = createService();
    docker.getManagedContainerConfiguration.mockRejectedValue(new Error('Policy lookup failed'));
    await expect(service.triggerUpdate({ nodeId: 'node-1', containerId: 'app', containerName: 'app' })).rejects.toThrow(
      'Policy lookup failed'
    );
    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(docker.recreateWithConfig).not.toHaveBeenCalled();
    expect(tasks.create).not.toHaveBeenCalled();
  });

  describe('a webhook call on a container with host bind mounts', () => {
    const MOUNTS = 'docker:containers:mounts:node-1';
    const hostBind = normalizeMountDefinitionsFromConfig({
      mounts: [{ hostPath: '/srv/app', containerPath: '/data', readOnly: false }],
    });
    const users: Record<string, Record<string, unknown>> = {
      ops: { id: 'ops', email: 'ops@example.com', name: 'Ops', scopes: [MOUNTS], isBlocked: false, isDeleted: false },
      viewer: { id: 'viewer', email: 'viewer@example.com', name: null, scopes: [], isBlocked: false, isDeleted: false },
      blocked: {
        id: 'blocked',
        email: 'b@example.com',
        name: null,
        scopes: [MOUNTS],
        isBlocked: true,
        isDeleted: false,
      },
      deleted: {
        id: 'deleted',
        email: 'd@example.com',
        name: null,
        scopes: [MOUNTS],
        isBlocked: false,
        isDeleted: true,
      },
    };

    /** The recreate runs the real mount guard against a container that has a host bind mount (or none). */
    function hostBindService(mounts = hostBind) {
      const auth = { getUserById: vi.fn(async (id: string) => users[id] ?? null) };
      const context = createService({}, auth);
      context.docker.recreateWithConfig.mockImplementation(
        async (_node: string, _id: string, _config: unknown, _user: unknown, options?: { actorScopes?: string[] }) => {
          assertDockerMountChangeAllowed({
            nodeId: 'node-1',
            actorScopes: options?.actorScopes ?? [],
            currentDefinitions: mounts,
            nextDefinitions: mounts,
          });
          return {};
        }
      );
      const trigger = (webhookOwnerId: string | null | undefined) =>
        context.service.triggerUpdate({
          nodeId: 'node-1',
          containerId: 'container-1',
          containerName: 'app',
          tag: 'new',
          webhookId: 'webhook-1',
          webhookOwnerId,
        });
      return { ...context, auth, trigger };
    }

    it('updates the image with the current scopes of the account that last saved the webhook', async () => {
      const { auth, docker, tasks, trigger } = hostBindService();

      await expect(trigger('ops')).resolves.toMatchObject({ taskId: 'task-1' });

      expect(auth.getUserById).toHaveBeenCalledWith('ops');
      expect(docker.recreateWithConfig).toHaveBeenCalledWith(
        'node-1',
        'container-1',
        expect.objectContaining({ image: 'registry.example.com/team/app:new' }),
        null,
        { skipImagePull: true, skipWebhookCleanup: true, actorScopes: [MOUNTS] }
      );
      expect(tasks.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    });

    it('refuses when that account lacks the scope, naming it, the scope and the fix', async () => {
      const { tasks, trigger } = hostBindService();

      const error = await trigger('viewer').catch((caught: unknown) => caught);

      expect(error).toMatchObject({ statusCode: 403, code: 'MISSING_DOCKER_MOUNTS_SCOPE' });
      expect((error as Error).message).toBe(
        'Webhook update refused: container "app" has host bind mounts, so running a new image on it needs docker:containers:mounts, and viewer@example.com, who last saved the webhook and whose permissions webhook calls use, does not hold docker:containers:mounts on it. Grant docker:containers:mounts on this workload to viewer@example.com, or save the webhook again as a user who holds it.'
      );
      expect(tasks.update).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ status: 'failed', error: (error as Error).message })
      );
    });

    it.each([
      [
        'no recorded account (saved before owners were recorded)',
        null,
        'Opfield cannot tell whose permissions the webhook uses',
      ],
      ['a deleted account', 'deleted', 'Opfield cannot tell whose permissions the webhook uses'],
      ['a blocked account', 'blocked', 'the account that last saved the webhook, b@example.com, is blocked'],
    ])('refuses with %s', async (_case, ownerId, reason) => {
      const { trigger } = hostBindService();

      const error = await trigger(ownerId).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ statusCode: 403, code: 'MISSING_DOCKER_MOUNTS_SCOPE' });
      expect((error as Error).message).toContain(reason);
      expect((error as Error).message).toContain(
        'Save the webhook again (configure it, or regenerate its URL) as a user who holds docker:containers:mounts on this workload.'
      );
    });

    it('leaves a container without host bind mounts unaffected, even with no recorded account', async () => {
      const { tasks, trigger } = hostBindService([]);

      await expect(trigger(null)).resolves.toMatchObject({ taskId: 'task-1' });
      expect(tasks.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    });

    it('passes the owner recorded on the webhook row from a token call', async () => {
      const { auth, service } = hostBindService();
      vi.spyOn(service, 'getByToken').mockResolvedValue({
        id: 'webhook-1',
        enabled: true,
        targetType: 'container',
        nodeId: 'node-1',
        containerName: 'app',
        updatedById: 'ops',
      } as never);

      await service.triggerWebhookToken('11111111-1111-4111-8111-111111111111', 'new');
      expect(auth.getUserById).toHaveBeenCalledWith('ops');
    });
  });

  it('runs a deployment webhook with the resolved account of the webhook', async () => {
    const deployments = { triggerWebhook: vi.fn().mockResolvedValue({ deploymentId: 'deployment-1' }) };
    const auth = {
      getUserById: vi.fn(async () => ({
        id: 'ops',
        email: 'ops@example.com',
        name: null,
        scopes: ['x'],
        isBlocked: false,
      })),
    };
    const service = new DockerWebhookService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      deployments as never,
      auth as never
    );
    vi.spyOn(service, 'getByToken').mockResolvedValue({
      id: 'webhook-1',
      enabled: true,
      targetType: 'deployment',
      updatedById: 'ops',
    } as never);

    await service.triggerWebhookToken('11111111-1111-4111-8111-111111111111', 'v3');

    expect(deployments.triggerWebhook).toHaveBeenCalledWith('webhook-1', 'v3', {
      user: { id: 'ops', label: 'ops@example.com' },
      unavailable: null,
      scopes: ['x'],
    });
  });

  it('records the account that created, changed or rotated a container webhook', async () => {
    const row: Record<string, unknown> = {};
    const writes: Array<Record<string, unknown>> = [];
    const returning = async () => [{ ...row }];
    const db = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          Object.assign(row, { id: 'webhook-1', ...values });
          writes.push(values);
          return { returning };
        },
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          Object.assign(row, patch);
          writes.push(patch);
          return { where: () => ({ returning }) };
        },
      }),
    };
    const service = new DockerWebhookService(
      db as never,
      {} as never,
      {} as never,
      { log: vi.fn().mockResolvedValue({}) } as never,
      {} as never,
      {} as never,
      {} as never
    );
    const getByContainer = vi.spyOn(service, 'getByContainer').mockResolvedValue(null as never);

    await service.upsert('node-1', 'app', { enabled: true }, 'creator');
    expect(row).toMatchObject({ createdById: 'creator', updatedById: 'creator' });

    getByContainer.mockResolvedValue({ ...row } as never);
    await service.upsert('node-1', 'app', { enabled: false }, 'editor');
    expect(row).toMatchObject({ createdById: 'creator', updatedById: 'editor', enabled: false });

    await service.regenerateToken('node-1', 'app', 'rotator');
    expect(row).toMatchObject({ createdById: 'creator', updatedById: 'rotator' });
    expect(writes).toHaveLength(3);
  });

  it('keeps the exact legacy physical pull and recreate path when HA configuration is null', async () => {
    const { cleanup, dispatch, docker, registry, service } = createService();

    await service.triggerUpdate({
      nodeId: 'node-1',
      containerId: 'container-1',
      containerName: 'app',
      tag: 'new',
      webhookId: 'webhook-1',
    });

    expect(registry.resolveAuthCandidatesForImagePull).toHaveBeenCalledWith(
      'node-1',
      'registry.example.com/team/app:new'
    );
    expect(dispatch.sendDockerImageCommand).toHaveBeenCalledWith(
      'node-1',
      'pull',
      { imageRef: 'registry.example.com/team/app:new', registryAuthJson: 'encoded-auth' },
      600000
    );
    expect(registry.rememberImageRegistry).toHaveBeenCalledWith(
      'node-1',
      'registry.example.com/team/app:new',
      'registry-1'
    );
    expect(docker.getManagedContainerConfiguration).toHaveBeenCalledWith('node-1', 'container-1');
    expect(docker.inspectContainer).toHaveBeenCalledExactlyOnceWith('node-1', 'container-1');
    expect(docker.getManagedContainerConfiguration.mock.invocationCallOrder[0]).toBeLessThan(
      docker.inspectContainer.mock.invocationCallOrder[0]!
    );
    expect(docker.recreateWithConfig).toHaveBeenCalledExactlyOnceWith(
      'node-1',
      'container-1',
      {
        image: 'registry.example.com/team/app:new',
        cmd: undefined,
        entrypoint: undefined,
        workingDir: undefined,
        user: undefined,
        hostname: undefined,
        labels: undefined,
        exposedPorts: undefined,
        hostConfig: {},
        networkingConfig: {},
      },
      null,
      // A webhook call with no recorded owner carries no scopes; a container without host binds needs none.
      { skipImagePull: true, skipWebhookCleanup: true, actorScopes: [] }
    );
    expect(cleanup.scheduleCleanupForContainer).toHaveBeenCalledExactlyOnceWith(
      'node-1',
      'app',
      'registry.example.com/team/app'
    );
  });

  it('converts Docker inspect env arrays before recreating from a webhook update', async () => {
    const { docker, service } = createService({
      Env: ['PATH=/bin', 'APP_PORT=4000', 'EMPTY=', 'NO_EQUALS'],
    });

    await service.triggerUpdate({
      nodeId: 'node-1',
      containerId: 'container-1',
      containerName: 'app',
      tag: 'new',
      webhookId: 'webhook-1',
    });

    const config = docker.recreateWithConfig.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(config.env).toEqual({
      PATH: '/bin',
      APP_PORT: '4000',
      EMPTY: '',
      NO_EQUALS: '',
    });
    expect(config.env).not.toHaveProperty('0');
  });

  it('does not introduce numeric env keys across repeated webhook updates', async () => {
    const { docker, service } = createService({
      Env: ['PATH=/bin', 'APP_PORT=4000'],
    });

    await service.triggerUpdate({
      nodeId: 'node-1',
      containerId: 'container-1',
      containerName: 'app',
      tag: 'new',
      webhookId: 'webhook-1',
    });
    await service.triggerUpdate({
      nodeId: 'node-1',
      containerId: 'container-1',
      containerName: 'app',
      tag: 'new',
      webhookId: 'webhook-1',
    });

    const recreateConfigs = docker.recreateWithConfig.mock.calls.map(
      (call) => call[2] as { env?: Record<string, string> }
    );
    expect(recreateConfigs).toHaveLength(2);
    for (const config of recreateConfigs) {
      expect(config.env).toEqual({ PATH: '/bin', APP_PORT: '4000' });
      expect(config.env).not.toHaveProperty('0');
      expect(Object.keys(config.env ?? {})).not.toContain('1');
    }
  });
});
