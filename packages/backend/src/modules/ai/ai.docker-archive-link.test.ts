import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { AppError } from '@/middleware/error-handler.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import {
  importDockerContainerArchive,
  openDockerContainerArchiveExport,
} from '@/modules/docker/docker-container-archive-operations.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CacheService } from '@/services/cache.service.js';
import type { User } from '@/types.js';
import {
  importDockerArchiveUploadLink,
  limitArchiveBody,
  openDockerArchiveDownloadLink,
} from './ai.docker-archive-link.js';
import { dockerArchiveLinkRoutes } from './ai.docker-archive-link.routes.js';
import { executeDockerTool } from './ai.docker-tools.js';
import { isImpersonationBlockedToolCall } from './ai-impersonation-policy.js';

vi.mock('@/modules/docker/docker-container-archive-operations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/docker/docker-container-archive-operations.js')>();
  return {
    assertDockerContainerArchiveExportAllowed: actual.assertDockerContainerArchiveExportAllowed,
    assertDockerContainerArchiveContentAccess: actual.assertDockerContainerArchiveContentAccess,
    importDockerContainerArchive: vi.fn(),
    openDockerContainerArchiveExport: vi.fn(),
  };
});
vi.mock('@/modules/nodes/service-creation-lock.js', () => ({
  assertNodeAllowsServiceCreation: vi.fn().mockResolvedValue(undefined),
}));

const NODE_ID = '44444444-4444-4444-8444-444444444444';
const CREATE = `docker:containers:create:${NODE_ID}`;
const VOLUME_EXPORT = 'docker:volumes:export:node-1/data';
const CONTAINER_EXPORT = 'docker:containers:export:node-1/scope-1';

const app = new Hono().route('/', dockerArchiveLinkRoutes);
app.onError((error, c) => {
  const { statusCode = 500, code } = error as AppError;
  return c.json({ code }, statusCode as 403);
});

function userWith(scopes: string[], overrides: Partial<User> = {}): User {
  return { id: 'user-1', isBlocked: false, scopes, ...overrides } as User;
}

function registerServices(owner: User) {
  const cache = new Map<string, unknown>();
  container.registerInstance(CacheService, {
    set: vi.fn(async (key: string, value: unknown) => void cache.set(key, value)),
    take: vi.fn(async (key: string) => {
      const value = cache.get(key) ?? null;
      cache.delete(key);
      return value;
    }),
  } as unknown as CacheService);
  container.registerInstance(GeneralSettingsService, {
    getPublicUrl: vi.fn().mockResolvedValue('https://opfield.example'),
  } as unknown as GeneralSettingsService);
  container.registerInstance(LicensePolicyService, {
    requireFeature: vi.fn().mockResolvedValue(undefined),
  } as unknown as LicensePolicyService);
  container.registerInstance(TOKENS.DrizzleClient, {} as never);
  const getUserById = vi.fn().mockResolvedValue(owner);
  container.registerInstance(AuthService, { getUserById } as unknown as AuthService);
  const docker = {
    inspectContainer: vi.fn().mockResolvedValue({ Id: 'container-1', Name: '/api', scopeResourceId: 'scope-1' }),
    assertUserVolumeVisible: vi.fn().mockResolvedValue(undefined),
    exportVolume: vi.fn().mockResolvedValue(Buffer.from('volume-tar-gz')),
  };
  container.registerInstance(DockerManagementService, docker as unknown as DockerManagementService);
  return { docker, getUserById };
}

function toolContext(docker: unknown) {
  return { dockerService: docker, ensureToolScope: vi.fn(), ensureToolScopeForResource: vi.fn() } as never;
}

function body(...chunks: (Buffer | Error)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        if (chunk instanceof Error) {
          controller.error(chunk);
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      }
      controller.close();
    },
  });
}

/** The import mock reads the whole body like the real importer and fails with the stream. */
function importReadsBody() {
  const received: { bytes: Buffer; error: unknown } = { bytes: Buffer.alloc(0), error: null };
  vi.mocked(importDockerContainerArchive).mockImplementation(async (args) => {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of args.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    } catch (error) {
      received.error = error;
      throw error;
    }
    received.bytes = Buffer.concat(chunks);
    return { containerId: 'new-1', containerName: args.name, imageId: 'sha256:1' };
  });
  return received;
}

async function uploadLink(docker: unknown, user: User) {
  const link = (await executeDockerTool(toolContext(docker), user, 'upload_docker_container_archive', {
    operation: 'link',
    nodeId: NODE_ID,
    name: 'restored-api',
    resolution: { ports: { '80/tcp': 8081 } },
  })) as { uploadUrl: string; commands: { file: string } };
  expect(link.uploadUrl).toMatch(/^https:\/\/opfield\.example\/api\/docker-archive-link\/opfau_/);
  expect(link.commands.file).toBe(`curl -sS --fail-with-body -T container.ofca '${link.uploadUrl}'`);
  return `/${link.uploadUrl.split('/').at(-1)}`;
}

async function downloadLink(docker: unknown, user: User, args: Record<string, unknown>) {
  const link = (await executeDockerTool(toolContext(docker), user, 'download_docker_archive', {
    operation: 'link',
    ...args,
  })) as { downloadUrl: string; filename: string; commands: { download: string } };
  expect(link.downloadUrl).toMatch(/^https:\/\/opfield\.example\/api\/docker-archive-link\/opfad_/);
  expect(link.commands.download).toBe(`curl -fsS -o '${link.filename}' '${link.downloadUrl}'`);
  return { path: `/${link.downloadUrl.split('/').at(-1)}`, filename: link.filename };
}

afterEach(() => {
  vi.clearAllMocks();
  container.reset();
});

describe('Docker archive upload links', () => {
  it('checks the import target when the link is made and imports one streamed body once', async () => {
    const user = userWith([CREATE, `docker:volumes:create:${NODE_ID}`]);
    const { docker } = registerServices(user);
    const received = importReadsBody();
    const path = await uploadLink(docker, user);
    expect(assertNodeAllowsServiceCreation).toHaveBeenCalledWith(expect.anything(), NODE_ID, 'docker');

    const response = await app.request(path, {
      method: 'PUT',
      body: body(Buffer.from('ofca-'), Buffer.from('archive')),
      duplex: 'half',
    } as RequestInit);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      data: { container: { containerId: 'new-1', containerName: 'restored-api', imageId: 'sha256:1' } },
    });
    expect(received.bytes.toString()).toBe('ofca-archive');
    expect(importDockerContainerArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: NODE_ID,
        name: 'restored-api',
        resolution: { ports: { '80/tcp': 8081 } },
        actorScopes: expect.arrayContaining([CREATE]),
        userId: 'user-1',
      })
    );
    const again = await app.request(path, { method: 'PUT', body: 'again' });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ code: 'DOCKER_ARCHIVE_LINK_INVALID' });
    expect(importDockerContainerArchive).toHaveBeenCalledTimes(1);
  });

  it('refuses to make a link without create access on the node', async () => {
    const user = userWith(['docker:containers:view']);
    const { docker } = registerServices(user);
    await expect(
      executeDockerTool(toolContext(docker), user, 'upload_docker_container_archive', {
        operation: 'link',
        nodeId: NODE_ID,
        name: 'api',
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(container.resolve(CacheService).set).not.toHaveBeenCalled();
  });

  it('rechecks the owner when the link is used', async () => {
    const user = userWith([CREATE]);
    const { docker, getUserById } = registerServices(user);
    importReadsBody();
    const path = await uploadLink(docker, user);
    getUserById.mockResolvedValue(userWith(['docker:containers:view']));

    await expect(importDockerArchiveUploadLink(path.slice(1), body(Buffer.from('ofca')))).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(importDockerArchiveUploadLink(path.slice(1), body(Buffer.from('ofca')))).rejects.toMatchObject({
      code: 'DOCKER_ARCHIVE_LINK_INVALID',
    });
    expect(importDockerContainerArchive).not.toHaveBeenCalled();
  });

  it('refuses a blocked owner', async () => {
    const user = userWith([CREATE]);
    const { docker, getUserById } = registerServices(user);
    const path = await uploadLink(docker, user);
    getUserById.mockResolvedValue(userWith([CREATE], { isBlocked: true }));

    await expect(importDockerArchiveUploadLink(path.slice(1), body(Buffer.from('ofca')))).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(importDockerContainerArchive).not.toHaveBeenCalled();
  });

  it('hands an interrupted transfer to the import as a failed stream, so the import rolls back', async () => {
    const user = userWith([CREATE]);
    const { docker } = registerServices(user);
    const received = importReadsBody();
    const path = await uploadLink(docker, user);

    await expect(
      importDockerArchiveUploadLink(path.slice(1), body(Buffer.from('ofca'), new Error('client went away')))
    ).rejects.toThrow('client went away');
    expect(received.error).toBeInstanceOf(Error);
    expect(received.bytes.byteLength).toBe(0);
  });

  it('errors a body larger than the limit', async () => {
    const chunks: Uint8Array[] = [];
    const reader = limitArchiveBody(body(Buffer.from('1234'), Buffer.from('5678')), 6).getReader();
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          chunks.push(value);
        }
      })()
    ).rejects.toMatchObject({ statusCode: 413, code: 'DOCKER_ARCHIVE_TOO_LARGE' });
    expect(Buffer.concat(chunks).toString()).toBe('1234');
  });
});

describe('Docker archive download links', () => {
  it('streams a volume archive once and ignores HEAD probes', async () => {
    const user = userWith([VOLUME_EXPORT]);
    const { docker } = registerServices(user);
    const { path, filename } = await downloadLink(docker, user, {
      kind: 'volume',
      nodeId: 'node-1',
      volumeName: 'data',
    });
    expect(filename).toBe('data.tar.gz');
    expect(docker.exportVolume).not.toHaveBeenCalled();

    expect((await app.request(path, { method: 'HEAD' })).status).toBe(405);
    const response = await app.request(path);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="data.tar.gz"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('volume-tar-gz');
    expect(docker.assertUserVolumeVisible).toHaveBeenCalledTimes(2);
    expect((await app.request(path)).status).toBe(404);
    expect(docker.exportVolume).toHaveBeenCalledTimes(1);
  });

  it('streams a container export with the export route checks and bounded scopes', async () => {
    const user = userWith([CONTAINER_EXPORT]);
    const { docker } = registerServices(userWith([CONTAINER_EXPORT, 'docker:containers:secrets']));
    vi.mocked(openDockerContainerArchiveExport).mockResolvedValue({
      filename: 'api.ofca',
      stream: body(Buffer.from('of'), Buffer.from('ca')),
    });
    const { path, filename } = await downloadLink(docker, user, {
      kind: 'container',
      nodeId: 'node-1',
      containerId: 'api',
      imageMode: 'registry',
      includeEnvironment: false,
    });
    expect(filename).toBe('api.ofca');

    const response = await app.request(path);
    expect(response.headers.get('content-type')).toBe('application/vnd.opfield.ofca');
    expect(await response.text()).toBe('ofca');
    expect(openDockerContainerArchiveExport).toHaveBeenCalledWith({
      nodeId: 'node-1',
      containerId: 'api',
      query: { imageMode: 'registry', includeWritableLayer: false, includeEnvironment: false, includeSecrets: false },
      actorScopes: [CONTAINER_EXPORT],
      userId: 'user-1',
    });
  });

  it('refuses to make a portable export link without file access', async () => {
    const user = userWith([CONTAINER_EXPORT]);
    const { docker } = registerServices(user);

    await expect(
      executeDockerTool(toolContext(docker), user, 'download_docker_archive', {
        operation: 'link',
        kind: 'container',
        nodeId: 'node-1',
        containerId: 'api',
        imageMode: 'portable',
        includeEnvironment: false,
      })
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('files access') });
    expect(openDockerContainerArchiveExport).not.toHaveBeenCalled();
  });

  it('refuses a download whose owner lost the export scope before anything is read', async () => {
    const user = userWith([VOLUME_EXPORT]);
    const { docker, getUserById } = registerServices(user);
    const { path } = await downloadLink(docker, user, { kind: 'volume', nodeId: 'node-1', volumeName: 'data' });
    getUserById.mockResolvedValue(userWith(['docker:volumes:view']));

    await expect(openDockerArchiveDownloadLink(path.slice(1))).rejects.toMatchObject({ statusCode: 403 });
    expect(docker.exportVolume).not.toHaveBeenCalled();
  });

  it('keeps upload and download links apart', async () => {
    const user = userWith([CREATE, VOLUME_EXPORT]);
    const { docker } = registerServices(user);
    importReadsBody();
    const upload = await uploadLink(docker, user);

    await expect(openDockerArchiveDownloadLink(upload.slice(1))).rejects.toMatchObject({
      code: 'DOCKER_ARCHIVE_LINK_INVALID',
    });
    const response = await app.request(upload, { method: 'PUT', body: 'ofca' });
    expect(response.status).toBe(201);
  });

  it('refuses a secret-bearing link while impersonating', () => {
    expect(
      isImpersonationBlockedToolCall('download_docker_archive', {
        operation: 'link',
        kind: 'container',
        includeSecrets: true,
      })
    ).toBe(true);
  });
});
