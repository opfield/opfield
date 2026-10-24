import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { DockerFolderService } from '@/modules/docker/docker-folder.service.js';
import { executeDockerTool } from './ai.docker-tools.js';
import {
  assertDockerToolNode,
  deniedNodeTargetText,
  listDockerAcrossNodes,
  type NodeDirectory,
  type NodeSummary,
  withNodeTargetGuidance,
} from './ai.node-target-guidance.js';
import { executeNodeTool } from './ai.node-tools.js';
import { describeToolError, formatToolError } from './ai-tool-errors.js';

const DOCKER_A = '11111111-1111-4111-8111-111111111111';
const DOCKER_B = '22222222-2222-4222-8222-222222222222';
const DATABASES = '33333333-3333-4333-8333-333333333333';
const NGINX = '44444444-4444-4444-8444-444444444444';
const BUILDER = '55555555-5555-4555-8555-555555555555';

const NODES: NodeSummary[] = [
  { id: DOCKER_A, type: 'docker', hostname: 'workloads', displayName: 'Root Workloads', status: 'online' },
  { id: DOCKER_B, type: 'docker', hostname: 'scrollo', displayName: null, status: 'offline' },
  { id: DATABASES, type: 'databases', hostname: 'root-databases', displayName: 'Root Databases', status: 'online' },
  { id: NGINX, type: 'nginx', hostname: 'root-ingress', displayName: 'Root Ingress', status: 'online' },
  { id: BUILDER, type: 'builder', hostname: 'build-1', displayName: 'Build Worker', status: 'online' },
];

/** The node table as the guidance reads it. */
const directory: NodeDirectory = {
  async findNode(id) {
    return NODES.find((node) => node.id === id) ?? null;
  },
  async listNodes(types) {
    return NODES.filter((node) => types.includes(node.type));
  },
};

const ADMIN = ['nodes:details', 'docker:containers:view', 'docker:volumes:view', 'proxy:view'];
/** Docker access on one node only, no node inventory. */
const LIMITED = [`docker:volumes:view:${DOCKER_A}`];

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return describeToolError(error);
  }
  throw new Error('expected a refusal');
}

async function guided(
  toolName: string,
  args: Record<string, unknown>,
  scopes: string[],
  error: unknown = undefined
): Promise<string> {
  const toolError = error
    ? describeToolError(error)
    : await refusal(() => assertDockerToolNode(toolName, args, directory));
  return withNodeTargetGuidance({
    message: formatToolError(toolError),
    code: toolError.code,
    toolName,
    args,
    scopes,
    directory,
  });
}

describe('Docker tools on a node that is not a Docker node', () => {
  it('refuse a databases or builder node before the handler runs', async () => {
    await expect(assertDockerToolNode('list_docker_images', { nodeId: DATABASES }, directory)).rejects.toMatchObject({
      code: 'NOT_DOCKER',
    });
    await expect(assertDockerToolNode('manage_docker_volume', { nodeId: BUILDER }, directory)).rejects.toMatchObject({
      code: 'NOT_DOCKER',
    });
    await expect(assertDockerToolNode('list_docker_volumes', { nodeId: DOCKER_A }, directory)).resolves.toBeUndefined();
    // Not node-bound: a registry list takes an optional node filter, and a missing nodeId lists across nodes.
    await expect(assertDockerToolNode('manage_docker_registry', { nodeId: NGINX }, directory)).resolves.toBeUndefined();
    await expect(assertDockerToolNode('list_docker_networks', {}, directory)).resolves.toBeUndefined();
  });

  it('name the node type and the Docker nodes the caller can use', async () => {
    const text = await guided('list_docker_networks', { nodeId: DATABASES }, ADMIN);
    expect(text).toContain('NOT_DOCKER: Node is not a Docker node.');
    expect(text).toContain(`"Root Databases" (${DATABASES}) is a databases node: Managed databases`);
    expect(text).toContain(`Docker nodes you can use: Root Workloads (${DOCKER_A}); scrollo (${DOCKER_B}, offline).`);
    expect(text).toContain('Omit nodeId to list across all of them.');
    expect(text).not.toContain(BUILDER);
  });

  it('do not reveal a node the caller cannot see, and list only the granted Docker nodes', async () => {
    const text = await guided('list_docker_volumes', { nodeId: DATABASES }, LIMITED);
    expect(text).not.toContain('Root Databases');
    expect(text).not.toContain('databases node');
    expect(text).toContain(`Docker nodes you can use: Root Workloads (${DOCKER_A}).`);
    expect(text).not.toContain(DOCKER_B);
  });

  it('turn a shortened id or a name into a not-found that asks for the full UUID', async () => {
    const short = await guided('list_docker_containers', { nodeId: '49b5e58f' }, ADMIN);
    expect(short).toContain('NODE_NOT_FOUND: Node "49b5e58f" not found: nodeId takes the full node UUID');
    expect(short).toContain(`Docker nodes you can use: Root Workloads (${DOCKER_A})`);
    const missing = await guided('get_docker_container', { nodeId: '99999999-9999-4999-8999-999999999999' }, ADMIN);
    expect(missing).toContain('NODE_NOT_FOUND');
    expect(missing).toContain('Docker nodes you can use');
    expect(missing).not.toContain('Omit nodeId');
  });
});

describe('node-type refusals of other tool families', () => {
  it('point a route on a Docker node to the nginx nodes', async () => {
    const text = await guided(
      'create_route',
      { nodeId: DOCKER_A },
      ADMIN,
      new AppError(400, 'NOT_NGINX', 'Node is not an nginx node')
    );
    expect(text).toContain(`"Root Workloads" (${DOCKER_A}) is a docker node: Docker workloads`);
    expect(text).toContain(`nginx nodes you can use: Root Ingress (${NGINX}).`);
  });

  it('point a managed database on a Docker node to the storage nodes', async () => {
    const text = await guided(
      'manage_managed_database',
      { nodeId: DOCKER_A },
      ['nodes:details', 'databases:create'],
      new AppError(409, 'NODE_TYPE_MISMATCH', 'Managed database operations require a databases node')
    );
    expect(text).toContain(`storage nodes you can use: Root Databases (${DATABASES}).`);
  });

  it('leave other errors unchanged', async () => {
    const message = 'CONTAINER_BUSY: Container is busy';
    await expect(
      withNodeTargetGuidance({
        message,
        code: 'CONTAINER_BUSY',
        toolName: 'stop_docker_container',
        args: { nodeId: DOCKER_A },
        scopes: ADMIN,
        directory,
      })
    ).resolves.toBe(message);
  });

  it('name the node a permission is missing on, only when the caller can see it', async () => {
    await expect(deniedNodeTargetText({ nodeId: NGINX }, ['nodes:details'], directory)).resolves.toBe(
      `on node "Root Ingress" (${NGINX}, type nginx)`
    );
    await expect(deniedNodeTargetText({ nodeId: NGINX }, LIMITED, directory)).resolves.toBe(`on node ${NGINX}`);
    await expect(deniedNodeTargetText({}, ADMIN, directory)).resolves.toBe('for this target');
  });
});

describe('Docker lists without nodeId', () => {
  const volumes: Record<string, unknown[]> = {
    [DOCKER_A]: [{ name: 'shop-data', driver: 'local', scope: 'local', usedBy: ['shop'] }],
  };
  const dockerService = {
    async listVolumes(nodeId: string) {
      if (!volumes[nodeId]) throw new AppError(502, 'NODE_OFFLINE', 'Node is offline');
      return volumes[nodeId];
    },
  };
  const context = { dockerService, ensureToolScope() {}, ensureToolScopeForResource() {} } as never;
  // The volume list carries each volume's folder (none here), as GET /docker/nodes/{nodeId}/volumes does.
  container.registerInstance(DockerFolderService, { getResourcePlacementsForRefs: async () => [] } as never);

  it('list every visible Docker node, tag each row with its node and report the nodes that cannot answer', async () => {
    const user = { id: 'u', scopes: ADMIN } as never;
    const result = await listDockerAcrossNodes(ADMIN, directory, (nodeId) =>
      executeDockerTool(context, user, 'list_docker_volumes', { nodeId })
    );
    expect(result.data).toEqual([
      expect.objectContaining({ nodeId: DOCKER_A, nodeName: 'Root Workloads', name: 'shop-data' }),
    ]);
    expect(result.total).toBe(1);
    expect(result.nodes).toEqual([{ nodeId: DOCKER_A, nodeName: 'Root Workloads', count: 1 }]);
    expect(result.unavailableNodes).toEqual([
      { nodeId: DOCKER_B, nodeName: 'scrollo', status: 'offline', error: 'NODE_OFFLINE: Node is offline' },
    ]);
  });

  it('only ask the Docker nodes a limited caller can see', async () => {
    const asked: string[] = [];
    const result = await listDockerAcrossNodes(LIMITED, directory, async (nodeId) => {
      asked.push(nodeId);
      return { data: [] };
    });
    expect(asked).toEqual([DOCKER_A]);
    expect(result.unavailableNodes).toBeUndefined();
  });

  it('say so when the caller can see no Docker node', async () => {
    const result = await listDockerAcrossNodes(['proxy:view'], directory, async () => ({ data: [] }));
    expect(result.total).toBe(0);
    expect(result.note).toContain('You can see no Docker nodes');
  });
});

describe('list_nodes', () => {
  it('says what each node is for and that daemonType is not the role', async () => {
    const listed = [
      { ...NODES[2], capabilities: { daemonType: 'docker' } },
      { ...NODES[0], capabilities: { daemonType: 'docker' } },
    ];
    const nodesService = {
      async list() {
        return { data: listed, total: listed.length, page: 1, limit: 50, totalPages: 1 };
      },
    };
    const result = (await executeNodeTool(
      { nodesService } as never,
      { id: 'u', scopes: ['nodes:details'] } as never,
      'list_nodes',
      {}
    )) as {
      data: Array<{ id: string; usedFor: string }>;
      note: string;
    };
    expect(result.data.find((node) => node.id === DATABASES)?.usedFor).toContain('Docker tools do not accept it');
    expect(result.data.find((node) => node.id === DOCKER_A)?.usedFor).toContain('list_docker_*');
    expect(result.note).toContain('capabilities.daemonType is the daemon build, not the role');
  });
});
