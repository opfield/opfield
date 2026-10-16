import { describe, expect, it } from 'vitest';
import { containerSourceAttachNotice } from './docker-source-attach-notice.js';

describe('attaching a Git source to an existing container', () => {
  it('says the first deploy replaces the image and the new image decides the port', () => {
    const notice = containerSourceAttachNotice(
      'web',
      { repositoryFullPath: 'acme/app', branch: 'main' },
      { Config: { Image: 'nginx:alpine', ExposedPorts: { '80/tcp': {} } }, HostConfig: { PortBindings: {} } }
    );

    expect(notice).toMatchObject({
      code: 'SOURCE_REPLACES_IMAGE',
      currentImage: 'nginx:alpine',
      currentExposedPorts: ['80/tcp'],
    });
    expect(notice?.message).toContain('replaces the image of container "web" (now nginx:alpine, port 80/tcp)');
    expect(notice?.message).toContain('acme/app (main)');
    expect(notice?.message).toContain('change the routes and port mappings');
  });

  it('has no notice for a container it could not read', () => {
    expect(containerSourceAttachNotice('web', { repositoryFullPath: 'acme/app', branch: 'main' }, null)).toBeNull();
  });
});
