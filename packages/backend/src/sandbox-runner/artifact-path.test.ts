import { constants } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openHostArtifact,
  openHostArtifactChildDirectory,
  openHostArtifactDirectory,
  resolveHostArtifactDirectory,
  resolveHostArtifactPath,
  supportsFdRelativeArtifactOpen,
} from './artifact-path.js';

let tempDir: string;
let workspaceDir: string;
let outsideDir: string;

describe('sandbox artifact host path resolution', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opfield-sandbox-artifact-path-test-'));
    workspaceDir = path.join(tempDir, 'workspace');
    outsideDir = path.join(tempDir, 'outside');
    await Promise.all([mkdir(workspaceDir), mkdir(outsideDir)]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates normal nested artifact parent directories inside the workspace', async () => {
    const allowDirectoryAccess = vi.fn().mockResolvedValue(undefined);
    const allowDirectoryHandleAccess = vi.fn().mockResolvedValue(undefined);
    const realWorkspaceDir = await realpath(workspaceDir);
    const fdRelativeOpenSupported = await supportsFdRelativeArtifactOpen();

    await expect(
      resolveHostArtifactPath(
        workspaceDir,
        'artifacts/nested/result.txt',
        allowDirectoryAccess,
        allowDirectoryHandleAccess
      )
    ).resolves.toMatchObject({
      path: path.join(realWorkspaceDir, 'artifacts', 'nested', 'result.txt'),
      parentPath: path.join(realWorkspaceDir, 'artifacts', 'nested'),
      parentSegments: ['artifacts', 'nested'],
      filename: 'result.txt',
    });
    if (fdRelativeOpenSupported) {
      expect(allowDirectoryHandleAccess).toHaveBeenCalled();
      expect(allowDirectoryAccess).not.toHaveBeenCalled();
    } else {
      expect(allowDirectoryAccess).toHaveBeenCalledWith(path.join(realWorkspaceDir, 'artifacts', 'nested'));
      expect(allowDirectoryHandleAccess).not.toHaveBeenCalled();
    }
  });

  it('rejects symlink parent components before creating directories through them', async () => {
    await symlink(outsideDir, path.join(workspaceDir, 'link'), 'dir');

    await expect(resolveHostArtifactPath(workspaceDir, 'link/new/result.txt')).rejects.toThrow('symbolic links');
    await expect(stat(path.join(outsideDir, 'new'))).rejects.toThrow();
  });

  it('opens artifact files without following a swapped final symlink', async () => {
    const outsideFile = path.join(outsideDir, 'secret.txt');
    const workspaceFile = path.join(workspaceDir, 'result.txt');
    await writeFile(workspaceFile, 'workspace');
    await writeFile(outsideFile, 'secret');

    const artifact = await resolveHostArtifactPath(workspaceDir, 'result.txt');
    await unlink(workspaceFile);
    await symlink(outsideFile, workspaceFile);

    if (!(await supportsFdRelativeArtifactOpen())) {
      await expect(openHostArtifact(artifact, constants.O_RDONLY)).rejects.toThrow('secure artifact access requires');
      return;
    }

    await expect(openHostArtifact(artifact, constants.O_RDONLY)).rejects.toThrow('symbolic links');
  });

  it('opens artifact files without following a swapped parent symlink', async () => {
    const workspaceParent = path.join(workspaceDir, 'artifacts');
    const outsideParent = path.join(outsideDir, 'artifacts');
    await mkdir(workspaceParent);
    await mkdir(outsideParent);
    await writeFile(path.join(workspaceParent, 'result.txt'), 'workspace');
    await writeFile(path.join(outsideParent, 'result.txt'), 'secret');

    const artifact = await resolveHostArtifactPath(workspaceDir, 'artifacts/result.txt');
    await rm(workspaceParent, { recursive: true, force: true });
    await symlink(outsideParent, workspaceParent, 'dir');

    if (!(await supportsFdRelativeArtifactOpen())) {
      await expect(openHostArtifact(artifact, constants.O_RDONLY)).rejects.toThrow('secure artifact access requires');
      return;
    }

    await expect(openHostArtifact(artifact, constants.O_RDONLY)).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('opens artifact directories without following a swapped child symlink', async () => {
    const workspaceParent = path.join(workspaceDir, 'artifacts');
    const outsideParent = path.join(outsideDir, 'artifacts');
    await mkdir(workspaceParent);
    await mkdir(outsideParent);

    const directory = await resolveHostArtifactDirectory(workspaceDir, '.');

    if (!(await supportsFdRelativeArtifactOpen())) {
      await expect(openHostArtifactDirectory(directory)).rejects.toThrow('secure artifact access requires');
      return;
    }

    const handle = await openHostArtifactDirectory(directory);
    try {
      await rm(workspaceParent, { recursive: true, force: true });
      await symlink(outsideParent, workspaceParent, 'dir');

      await expect(openHostArtifactChildDirectory(handle, 'artifacts')).rejects.toMatchObject({ code: 'ELOOP' });
    } finally {
      await handle.close().catch(() => {});
    }
  });

  it('rejects an artifact target that is a symbolic link', async () => {
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await writeFile(outsideFile, 'secret');
    await symlink(outsideFile, path.join(workspaceDir, 'result.txt'));

    await expect(resolveHostArtifactPath(workspaceDir, 'result.txt')).rejects.toThrow('symbolic link');
  });
});
