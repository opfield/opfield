import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { executeDockerTool } from '@/modules/ai/ai.docker-tools.js';
import type { User } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { duplicateContainer } from './docker-container-mutation-operations.js';
import { getContainerEnv } from './docker-env-operations.js';
import { DOCKER_DUPLICATE_ENV_REMOVAL_CAPABILITY } from './docker-secret-env.js';

vi.mock('@/modules/nodes/service-creation-lock.js', () => ({
  assertNodeAllowsServiceCreation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./docker-creation-access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./docker-creation-access.js')>()),
  placeCreatedDockerResource: vi.fn().mockResolvedValue(undefined),
}));
// get_docker_container also names the container's Git source, which is read from the database.
vi.mock('./docker-source-build-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./docker-source-build-state.js')>()),
  readContainerGitSource: vi.fn().mockResolvedValue(null),
}));

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT_ID = '22222222-2222-4222-8222-222222222222';
const COMPOSE_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DATABASE_URL = 'postgres://app_link:link-password-123@gw-db-link:5432/app';
const S3_SECRET = 's3-secret-access-key-456';
const COMPOSE_TOKEN = 'compose-api-token-789';

/** A blue/green slot: the deployment's secrets, its link credentials included, are stored under the deployment. */
const slotInspect = () => ({
  Id: 'slot-id',
  Name: '/web-blue',
  Config: {
    Labels: { 'wiolett.gateway.deployment.managed': 'true', 'wiolett.gateway.deployment.id': DEPLOYMENT_ID },
    Env: [`DATABASE_URL=${DATABASE_URL}`, `AWS_SECRET_ACCESS_KEY=${S3_SECRET}`, 'MODE=prod'],
  },
});

/** A Compose service: project secrets reach its env through interpolation, under the service's own names. */
const composeInspect = () => ({
  Id: 'compose-id',
  Name: '/shop-api-1',
  Config: {
    Labels: { 'wiolett.gateway.compose.project-id': COMPOSE_PROJECT_ID, 'com.docker.compose.project': 'shop' },
    Env: [`DB=${DATABASE_URL}`, `API_URL=https://user:${COMPOSE_TOKEN}@api.example`, 'MODE=prod'],
  },
});

const secretService = {
  getSecretKeys: vi.fn(async (_nodeId: string, owner: string) =>
    owner === `deployment:${DEPLOYMENT_ID}` ? new Set(['DATABASE_URL', 'AWS_SECRET_ACCESS_KEY']) : new Set<string>()
  ),
  getDecryptedMap: vi.fn(async (_nodeId: string, owner: string) =>
    owner === `compose:${COMPOSE_PROJECT_ID}` ? { OPFIELD_DB_LINK: DATABASE_URL, API_TOKEN: COMPOSE_TOKEN } : {}
  ),
};

/** The real inspect and masking over a node that answers with `inspect`. */
function dockerWith(inspect: Record<string, unknown>) {
  return {
    secretService,
    validateDockerNode: vi.fn().mockResolvedValue(undefined),
    nodeDispatch: { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true }) },
    parseResult: () => structuredClone(inspect),
    decorateContainerDetailSnapshot: vi.fn(async (_nodeId: string, data: Record<string, unknown>) => ({
      ...data,
      scopeResourceId: DEPLOYMENT_ID,
    })),
    inspectContainer: DockerManagementService.prototype.inspectContainer,
    maskSecretEnv: DockerManagementService.prototype.maskSecretEnv,
  };
}

function user(scopes: string[]): User {
  return { id: 'user-1', isBlocked: false, scopes } as User;
}

afterEach(() => {
  container.reset();
  vi.clearAllMocks();
});

describe('container inspect secrets', () => {
  it('masks a deployment slot link credentials and keeps its plain env', async () => {
    const data = await dockerWith(slotInspect()).inspectContainer(NODE_ID, 'slot-id');
    expect(data.Config.Env).toEqual(['DATABASE_URL=********', 'AWS_SECRET_ACCESS_KEY=********', 'MODE=prod']);
  });

  it('masks a Compose service env that carries a project secret under another name', async () => {
    const data = await dockerWith(composeInspect()).inspectContainer(NODE_ID, 'compose-id');
    expect(data.Config.Env).toEqual(['DB=********', 'API_URL=********', 'MODE=prod']);
  });

  it('never reveals link credentials over MCP get_docker_container, whatever reveal grants the caller holds', async () => {
    const docker = dockerWith(slotInspect());
    const context = { dockerService: docker, ensureToolScope: vi.fn(), ensureToolScopeForResource: vi.fn() } as never;
    const resource = `${NODE_ID}/${DEPLOYMENT_ID}`;

    const withEnvironment = (await executeDockerTool(
      context,
      user([
        `docker:containers:view:${resource}`,
        `docker:containers:environment:${resource}`,
        `docker:containers:secrets:${resource}`,
        'databases:credentials:reveal',
        'storage:credentials:reveal',
      ]),
      'get_docker_container',
      { nodeId: NODE_ID, containerId: 'slot-id' }
    )) as { Config: { Env: string[] } };
    expect(withEnvironment.Config.Env).toEqual([
      'DATABASE_URL=********',
      'AWS_SECRET_ACCESS_KEY=********',
      'MODE=prod',
    ]);

    const viewOnly = (await executeDockerTool(
      context,
      user([`docker:containers:view:${resource}`]),
      'get_docker_container',
      {
        nodeId: NODE_ID,
        containerId: 'slot-id',
      }
    )) as { Config: Record<string, unknown> };
    expect(viewOnly.Config.Env).toBeUndefined();
  });

  it('leaves a slot link credentials out of the env route', async () => {
    const env = await getContainerEnv(
      {
        nodeDispatch: { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true }) } as never,
        secretService: secretService as never,
        parseResult: () => slotInspect(),
      },
      NODE_ID,
      'slot-id'
    );
    expect(env).toEqual(['MODE=prod']);
  });
});

describe('container duplicate', () => {
  function duplicateContext(capabilities: string[]) {
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({ success: true });
    const copySecrets = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      db: {},
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand },
      secretService: {
        getManagedSecretKeys: vi.fn().mockResolvedValue(['DATABASE_URL', 'AWS_SECRET_ACCESS_KEY']),
        copySecrets,
      },
      validateDockerNode: vi.fn().mockResolvedValue({ capabilities: { capabilities } }),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('api'),
      inspectContainer: vi.fn().mockResolvedValue({ Id: 'api-id', Name: '/api', Config: { Labels: {} } }),
      requireNoTransition: vi.fn(),
      assertNameAvailable: vi.fn().mockResolvedValue(undefined),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      parseResult: () => ({ Id: 'copy-id' }),
      emitContainer: vi.fn(),
    };
    return { ctx, sendDockerContainerCommand, copySecrets };
  }

  it('leaves the source link variables out of the copy', async () => {
    const { ctx, sendDockerContainerCommand, copySecrets } = duplicateContext([
      DOCKER_DUPLICATE_ENV_REMOVAL_CAPABILITY,
    ]);
    await duplicateContainer(ctx as never, NODE_ID, 'api-id', 'api-copy', 'user-1');
    expect(sendDockerContainerCommand).toHaveBeenCalledWith(NODE_ID, 'duplicate', {
      containerId: 'api-id',
      newName: 'api-copy',
      configJson: JSON.stringify({ removeEnv: ['DATABASE_URL', 'AWS_SECRET_ACCESS_KEY'] }),
    });
    expect(copySecrets).toHaveBeenCalledWith(NODE_ID, 'api', 'api-copy', 'user-1');
  });

  it('duplicates a container whose image declares a VOLUME without asking for a managed volume', async () => {
    const { ctx, sendDockerContainerCommand } = duplicateContext([DOCKER_DUPLICATE_ENV_REMOVAL_CAPABILITY]);
    ctx.inspectContainer.mockResolvedValue({
      Id: 'api-id',
      Name: '/api',
      Config: { Labels: {}, Volumes: { '/data': {} } },
      Mounts: [
        {
          Type: 'volume',
          Name: 'e9fa86844b2fbf2d206241693d4a98a949be8f9f395695db4cbf3e276965cd27',
          Destination: '/data',
        },
      ],
    } as never);
    await duplicateContainer(ctx as never, NODE_ID, 'api-id', 'api-copy', 'user-1');
    expect(sendDockerContainerCommand).toHaveBeenCalledWith(
      NODE_ID,
      'duplicate',
      expect.objectContaining({ newName: 'api-copy' })
    );
  });

  it('refuses to duplicate a linked container on a daemon that would copy the link variables', async () => {
    const { ctx, sendDockerContainerCommand } = duplicateContext([]);
    await expect(duplicateContainer(ctx as never, NODE_ID, 'api-id', 'api-copy', 'user-1')).rejects.toMatchObject({
      code: 'UNSUPPORTED_DAEMON',
    });
    expect(sendDockerContainerCommand).not.toHaveBeenCalled();
  });
});
