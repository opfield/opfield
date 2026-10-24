import { describe, expect, it } from 'vitest';
import { dockerDaemonUserError } from './docker-daemon-errors.js';

describe('Docker daemon refusals caused by the request', () => {
  it('answer 4xx with a text that says what to do', () => {
    expect(
      dockerDaemonUserError(
        'Error response from daemon: driver failed programming external connectivity on endpoint c2 (abc): Bind for 0.0.0.0:18302 failed: port is already allocated'
      )
    ).toMatchObject({ statusCode: 409, code: 'HOST_PORT_IN_USE', message: expect.stringContaining('Host port 18302') });
    expect(dockerDaemonUserError('Error response from daemon: No such image: podinfo:9.9.9')).toMatchObject({
      statusCode: 409,
      code: 'IMAGE_NOT_ON_NODE',
      message: expect.stringContaining('podinfo:9.9.9'),
    });
    expect(dockerDaemonUserError('disk-image volumes are not supported on this node')).toMatchObject({
      statusCode: 409,
      code: 'DISK_IMAGE_VOLUMES_UNSUPPORTED',
    });
    expect(
      dockerDaemonUserError('Error response from daemon: network with name mx-d2-smn6r already exists')
    ).toMatchObject({ statusCode: 409, code: 'NAME_IN_USE', message: expect.stringContaining('"mx-d2-smn6r"') });
    // The daemon's words stay where callers match them.
    expect(dockerDaemonUserError('Error response from daemon: No such container: api')).toMatchObject({
      statusCode: 404,
      code: 'CONTAINER_NOT_FOUND',
      message: 'Error response from daemon: No such container: api',
    });
  });

  it('leave other daemon failures to the dispatch error', () => {
    expect(dockerDaemonUserError('context deadline exceeded')).toBeNull();
  });
});
