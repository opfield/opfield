import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { dockerContainerFolders } from '@/db/schema/index.js';
import {
  LEGACY_DATABASE_LINK_NETWORK_PREFIX,
  LEGACY_INSTALL_DIR_NAME,
  LEGACY_SECURE_LINK_NETWORK,
} from '@/lib/legacy-compat.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { DockerManagementService } from './docker.service.js';
import { canImportArchiveContent, importDockerContainerArchive } from './docker-container-archive-operations.js';
import { DockerEnvironmentService } from './docker-environment.service.js';
import { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';
import { DockerRegistryService } from './docker-registry.service.js';
import { DockerSecretService } from './docker-secret.service.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_FOLDER_ID = '33333333-3333-4333-8333-333333333333';

function setup(
  archive: {
    environment?: Record<string, string>;
    secrets?: Record<string, string>;
    networks?: Array<{ name: string; createable: boolean }>;
  } = {}
) {
  // Destination folder lookup of assertDockerCreationAccess: an ordinary container folder. No Git source reserves
  // the imported name.
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: vi
            .fn()
            .mockResolvedValue(table === dockerContainerFolders ? [{ id: FOLDER_ID, isSystem: false }] : []),
        }),
      }),
    }),
  };
  const executeDockerArchive = vi.fn(
    async (_operation: string, args: { authorizeContents: (value: unknown) => Promise<void> }) => {
      await args.authorizeContents({ networks: [], mounts: [], ...archive });
      return {
        containerId: 'container-1',
        containerName: 'imported',
        imageId: 'sha256:image',
        environment: archive.environment ?? {},
        secrets: archive.secrets ?? {},
        createdVolumes: [],
        archiveId: 'archive-1',
      };
    }
  );
  const docker = {
    assertManagedVolumeSelections: vi.fn().mockResolvedValue(undefined),
    registerImportedContainer: vi.fn().mockResolvedValue(undefined),
    registerImportedManagedVolumes: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
  };
  container.registerInstance(TOKENS.DrizzleClient, db as never);
  container.registerInstance(TOKENS.CommercialEdition, { executeDockerArchive } as never);
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(DockerMigrationDispatchAdapter, { cleanupArchiveImport: vi.fn() } as never);
  container.registerInstance(DockerRegistryService, { resolveAuthCandidatesForImagePull: vi.fn() } as never);
  container.registerInstance(DockerEnvironmentService, {
    replace: vi.fn().mockResolvedValue(undefined),
    deleteImported: vi.fn(),
  } as never);
  container.registerInstance(DockerSecretService, {
    replaceImported: vi.fn().mockResolvedValue(undefined),
    deleteImported: vi.fn(),
  } as never);
  container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as never);
  return { executeDockerArchive, docker };
}

const importInto = (folderId: string | undefined, actorScopes: string[]) =>
  importDockerContainerArchive({
    nodeId: NODE_ID,
    name: 'imported',
    folderId,
    resolution: {},
    body: new ReadableStream(),
    actorScopes,
    userId: 'user-1',
  });

afterEach(() => container.reset());

describe('container archive import destination', () => {
  const folderScopes = [
    `docker:containers:create:folder/${FOLDER_ID}`,
    `docker:containers:secrets:folder/${FOLDER_ID}`,
  ];

  it('imports into a folder the user may create in, including the secrets a folder grant covers', async () => {
    const { executeDockerArchive, docker } = setup({ secrets: { TOKEN: 'secret' } });

    await expect(importInto(FOLDER_ID, folderScopes)).resolves.toMatchObject({ containerName: 'imported' });

    expect(executeDockerArchive).toHaveBeenCalledOnce();
    expect(docker.registerImportedContainer).toHaveBeenCalledWith(
      NODE_ID,
      'imported',
      'container-1',
      FOLDER_ID,
      'user-1'
    );
  });

  it('refuses root and other folders for a folder-only creator before reading the archive', async () => {
    const { executeDockerArchive } = setup();

    await expect(importInto(undefined, folderScopes)).rejects.toMatchObject({ statusCode: 403 });
    await expect(importInto(OTHER_FOLDER_ID, folderScopes)).rejects.toMatchObject({ statusCode: 403 });
    expect(executeDockerArchive).not.toHaveBeenCalled();
  });

  it('refuses archive secrets without a secrets grant on the node or the destination folder', async () => {
    const { docker } = setup({ secrets: { TOKEN: 'secret' } });

    await expect(importInto(FOLDER_ID, [`docker:containers:create:folder/${FOLDER_ID}`])).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(docker.registerImportedContainer).not.toHaveBeenCalled();
  });

  it('refuses archive networks a direct create refuses: host, shared namespaces and Opfield-managed networks', async () => {
    const scopes = [`docker:containers:create:${NODE_ID}`, `docker:networks:create:${NODE_ID}`];
    for (const name of [
      'host',
      'container:abc',
      LEGACY_SECURE_LINK_NETWORK,
      `${LEGACY_DATABASE_LINK_NETWORK_PREFIX}0123456789abcdef`,
    ]) {
      const { docker } = setup({ networks: [{ name, createable: true }] });
      await expect(importInto(undefined, scopes)).rejects.toMatchObject({
        statusCode: name.startsWith(`${LEGACY_INSTALL_DIR_NAME}`) ? 409 : 400,
      });
      expect(docker.registerImportedContainer).not.toHaveBeenCalled();
      container.reset();
    }
  });

  it('checks archive content grants on the node or the destination folder only', () => {
    const scope = 'docker:containers:environment';
    expect(canImportArchiveContent([`${scope}:${NODE_ID}`], scope, NODE_ID, undefined)).toBe(true);
    expect(canImportArchiveContent([`${scope}:folder/${FOLDER_ID}`], scope, NODE_ID, FOLDER_ID)).toBe(true);
    expect(canImportArchiveContent([`${scope}:folder/${FOLDER_ID}`], scope, NODE_ID, OTHER_FOLDER_ID)).toBe(false);
    expect(canImportArchiveContent([`${scope}:folder/${FOLDER_ID}`], scope, NODE_ID, undefined)).toBe(false);
  });
});
