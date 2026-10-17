import 'reflect-metadata';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { container } from '@/container.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsService,
} from '@/modules/settings/environment-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { createApp } from './app.js';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ||= 'http://localhost/db';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.OIDC_ISSUER ||= 'http://localhost/oidc';
  process.env.OIDC_CLIENT_ID ||= 'test';
  process.env.OIDC_CLIENT_SECRET ||= 'test';
  process.env.OIDC_REDIRECT_URI ||= 'http://localhost/auth/callback';
  process.env.APP_URL = 'http://opfield.test';
  process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
});

afterEach(() => {
  container.reset();
});

describe('request body limits', () => {
  async function expectPayloadTooLarge(path: string, method: string, body: string, contentType = 'application/json') {
    const { app } = createApp();
    const response = await app.request(path, {
      method,
      headers: {
        host: 'opfield.test',
        'content-type': contentType,
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  }

  async function expectNotPayloadTooLarge(path: string, method: string, body: string) {
    const { app } = createApp();
    const response = await app.request(path, {
      method,
      headers: {
        host: 'opfield.test',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });

    expect(response.status).not.toBe(413);
  }

  it('rejects oversized OAuth token bodies before route parsing', async () => {
    const body = `grant_type=authorization_code&code=${'x'.repeat(40_000)}`;
    await expectPayloadTooLarge('/api/oauth/token', 'POST', body, 'application/x-www-form-urlencoded');
  });

  it('rejects oversized logging ingest bodies before route parsing', async () => {
    await expectPayloadTooLarge('/api/logging/ingest', 'POST', 'x'.repeat(1_100_000));
  });

  it('rejects oversized local-auth and passkey JSON before route parsing', async () => {
    const body = JSON.stringify({ response: 'x'.repeat(40_000) });
    await expectPayloadTooLarge('/auth/password/login', 'POST', body);
    await expectPayloadTooLarge('/auth/passkeys/verify', 'POST', body);
  });

  it('uses the avatar upload limit instead of the smaller OAuth body limit', async () => {
    await expectNotPayloadTooLarge('/auth/me/avatar', 'PUT', 'x'.repeat(200_000));
  });

  it('rejects avatar upload bodies above the dedicated upload limit', async () => {
    await expectPayloadTooLarge('/auth/me/avatar', 'PUT', 'x'.repeat(1_400_000), 'multipart/form-data');
  });

  it('does not apply the global API body limit to Docker file write bodies', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/containers/container-1/files/write',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to Docker file create bodies', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/containers/container-1/files/create',
      'POST',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to Docker file upload chunks', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/containers/container-1/files/uploads/upload-123456/chunks?offset=0',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to Docker volume file write bodies', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/volumes/volume-1/files/write',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to Docker volume file create bodies', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/volumes/volume-1/files/create',
      'POST',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to Docker volume file upload chunks', async () => {
    await expectNotPayloadTooLarge(
      '/api/docker/nodes/node-1/volumes/volume-1/files/uploads/upload-123456/chunks?offset=0',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('does not apply the global API body limit to node file write bodies', async () => {
    await expectNotPayloadTooLarge('/api/nodes/node-1/files/write', 'PUT', 'x'.repeat(1_600_000));
  });

  it('does not apply the global API body limit to node file create bodies', async () => {
    await expectNotPayloadTooLarge('/api/nodes/node-1/files/create', 'POST', 'x'.repeat(1_600_000));
  });

  it('does not apply the global API body limit to node file upload chunks', async () => {
    await expectNotPayloadTooLarge(
      '/api/nodes/node-1/files/uploads/upload-123456/chunks?offset=0',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('uses the file upload limit instead of the global API body limit for object uploads', async () => {
    await expectNotPayloadTooLarge(
      '/api/object-storage/storage-1/objects/upload?bucket=app&key=large.bin',
      'POST',
      'x'.repeat(3_000_000)
    );
    await expectPayloadTooLarge('/api/object-storage/storage-1/objects/prefix', 'POST', 'x'.repeat(3_000_000));
  });

  it('refuses an object larger than the file upload limit with that limit, and takes one exactly as large', async () => {
    const maxBytes = 1024 * 1024;
    const upload = async (bytes: number) => {
      container.registerInstance(GeneralSettingsService, {
        getConfig: async () => ({ fileUploadMaxBytes: maxBytes }),
      } as unknown as GeneralSettingsService);
      const { app } = createApp();
      return app.request('/api/object-storage/storage-1/objects/upload?bucket=app&key=large.bin', {
        method: 'POST',
        headers: {
          host: 'opfield.test',
          'content-type': 'application/octet-stream',
          'content-length': String(bytes),
        },
        body: 'x'.repeat(bytes),
      });
    };
    const refused = await upload(maxBytes + 1);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({
      code: 'STORAGE_UPLOAD_TOO_LARGE',
      message: 'The object is larger than the file upload limit of 1 MB set in Settings',
      details: { maxBytes },
    });
    expect((await upload(maxBytes)).status).not.toBe(413);
  });

  it('uses the Pages chunk limit instead of the global API body limit', async () => {
    await expectNotPayloadTooLarge(
      '/api/pages-deploy/uploads/11111111-1111-4111-8111-111111111111/chunks',
      'PUT',
      'x'.repeat(1_600_000)
    );
  });

  it('rejects Pages upload chunks above 8 MiB before route handling', async () => {
    await expectPayloadTooLarge(
      '/api/pages-deploy/uploads/11111111-1111-4111-8111-111111111111/chunks',
      'PUT',
      'x'.repeat(8 * 1024 * 1024 + 1)
    );
  });

  it('uses the larger inference-specific limit instead of the global API limit', async () => {
    await expectNotPayloadTooLarge('/api/inference/v1/responses', 'POST', 'x'.repeat(3_000_000));
  });

  it('accepts inference requests above the removed legacy 32 MiB ceiling', async () => {
    await expectNotPayloadTooLarge('/api/inference/v1/responses', 'POST', 'x'.repeat(34_000_000));
  });

  it('applies a changed inference limit without restarting the app', async () => {
    container.registerInstance(EnvironmentSettingsService, {
      getSnapshot: () => ({
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        requestLimits: {
          ...DEFAULT_ENVIRONMENT_SETTINGS.requestLimits,
          inferenceHttpBodyMaxBytes: 4 * 1024 * 1024,
        },
      }),
    } as never);

    await expectPayloadTooLarge('/api/inference/v1/responses', 'POST', 'x'.repeat(5 * 1024 * 1024));
  });
});
