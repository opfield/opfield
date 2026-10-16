import { describe, expect, it } from 'vitest';
import { opfieldHostImageRepositories, selectOldOpfieldHostImages } from './housekeeping-host-images.js';

const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

describe('old Opfield images on the Opfield host', () => {
  it('finds app and relay images pulled by digest, keeps the running, configured and one rollback image of each', () => {
    const app = 'ghcr.io/opfield/opfield';
    const images = [
      // The app runs from a digest reference: no tag at all.
      { Id: 'sha256:app-current', RepoDigests: [`${app}@${digest(1)}`], Created: 50, Size: 500 },
      { Id: 'sha256:app-previous', RepoDigests: [`${app}@${digest(2)}`], Created: 40, Size: 500 },
      { Id: 'sha256:app-old', RepoDigests: [`${app}@${digest(3)}`], Created: 30, Size: 500 },
      // Under the earlier repository names, and the local name of early installs.
      {
        Id: 'sha256:app-legacy',
        RepoDigests: [`ghcr.io/the-square-labs/gateway@${digest(4)}`],
        Created: 20,
        Size: 400,
      },
      {
        Id: 'sha256:app-gitlab',
        RepoTags: ['registry.gitlab.wiolett.net/wiolett/gateway:2.9.0'],
        Created: 5,
        Size: 300,
      },
      { Id: 'sha256:app-local', RepoTags: ['gateway:2.8.17'], Created: 1, Size: 200 },
      { Id: 'sha256:relay-current', RepoDigests: [`${app}/relay@${digest(5)}`], Created: 50, Size: 30 },
      { Id: 'sha256:relay-unused-new', RepoDigests: [`${app}/relay@${digest(6)}`], Created: 45, Size: 30 },
      {
        Id: 'sha256:relay-old',
        RepoDigests: [`ghcr.io/the-square-labs/gateway/relay@${digest(7)}`],
        Created: 10,
        Size: 30,
      },
      {
        Id: 'sha256:relay-gitlab',
        RepoDigests: [`registry.gitlab.wiolett.net/wiolett/gateway/relay@${digest(8)}`],
        Created: 9,
        Size: 30,
      },
      // Not Opfield's: never touched.
      { Id: 'sha256:postgres', RepoTags: ['postgres:16.15-alpine'], Created: 1, Size: 100 },
      { Id: 'sha256:user', RepoTags: ['myorg/gateway:1'], Created: 1, Size: 100 },
    ];

    const removable = selectOldOpfieldHostImages({
      images,
      // The relay runs the configured image; a stopped container still uses the GitLab-era app image.
      inUseImageIds: new Set(['sha256:app-current', 'app-gitlab']),
      selfImageId: 'sha256:app-current',
      appRepositories: opfieldHostImageRepositories(`${app}@${digest(1)}`, ['ghcr.io/opfield/opfield']),
      keepReferences: [`${app}/relay@${digest(5)}`],
    });

    expect(removable.map((image) => image.id).sort()).toEqual([
      'sha256:app-legacy',
      'sha256:app-local',
      'sha256:app-old',
      'sha256:relay-gitlab',
      'sha256:relay-old',
    ]);
    expect(removable.find((image) => image.id === 'sha256:app-old')).toEqual({
      id: 'sha256:app-old',
      family: 'app',
      size: 500,
    });
  });

  it('keeps everything when the host has a single image of each', () => {
    expect(
      selectOldOpfieldHostImages({
        images: [{ Id: 'sha256:a', RepoTags: ['ghcr.io/opfield/opfield:v2.12.3'], Created: 1 }],
        inUseImageIds: new Set(),
        appRepositories: opfieldHostImageRepositories('ghcr.io/opfield/opfield:v2.12.3'),
      })
    ).toEqual([]);
  });
});
