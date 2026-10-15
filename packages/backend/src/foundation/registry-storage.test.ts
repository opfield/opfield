import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { patchCompose, patchComposeRegistryStorage } from './foundation-migrator.js';
import { applyRegistryStorageEnv, registryStorageBackendFromEnv } from './registry-storage.js';

const COMPOSE = `services:
  app:
    image: \${OPFIELD_IMAGE_REF}
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`;

const S3 = {
  endpoint: 'http://seaweedfs:8333',
  region: 'us-east-1',
  bucket: 'registry',
  rootDirectory: 'opfield',
  forcePathStyle: true,
  accessKeyId: 'key',
  secretAccessKey: 'se/cr+et=$x',
};

function registryEnvironment(compose: string): Record<string, unknown> {
  return (parseDocument(compose).toJS() as { services: { registry: { environment: Record<string, unknown> } } })
    .services.registry.environment;
}

describe('registry storage in .env and docker-compose.yml', () => {
  it('switches the registry block between the volume and S3 and back, and updates keep the choice', () => {
    const filesystem = patchCompose(COMPOSE);
    expect(registryEnvironment(filesystem)).toMatchObject({
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: '/var/lib/registry',
      REGISTRY_STORAGE_DELETE_ENABLED: 'true',
    });
    expect(registryEnvironment(filesystem).REGISTRY_STORAGE).toBeUndefined();

    const s3 = patchComposeRegistryStorage(filesystem, 's3');
    const environment = registryEnvironment(s3);
    // The registry refuses a second storage driver: no filesystem setting next to S3.
    expect(environment.REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY).toBeUndefined();
    expect(environment).toMatchObject({
      REGISTRY_STORAGE: 's3',
      REGISTRY_STORAGE_S3_BUCKET: `\${OPFIELD_REGISTRY_S3_BUCKET}`,
      REGISTRY_STORAGE_S3_SECRETKEY: `\${OPFIELD_REGISTRY_S3_SECRETKEY}`,
      REGISTRY_STORAGE_REDIRECT_DISABLE: 'true',
      REGISTRY_STORAGE_DELETE_ENABLED: 'true',
    });
    expect(s3).not.toContain(S3.secretAccessKey);
    expect(s3).toContain('registry_data:/var/lib/registry');
    // An update without an explicit choice keeps the block's storage; the .env choice is what updates pass.
    expect(patchCompose(s3)).toBe(s3);
    expect(patchCompose(s3, false, { registryStorage: 'filesystem' })).toBe(filesystem);
    expect(patchComposeRegistryStorage(s3, 'filesystem')).toBe(filesystem);

    const env = applyRegistryStorageEnv('DB_PASSWORD=x\n', S3);
    expect(env).toContain(`OPFIELD_REGISTRY_S3_SECRETKEY='${S3.secretAccessKey}'`);
    expect(env).toContain("OPFIELD_REGISTRY_S3_SECURE='false'");
    expect(registryStorageBackendFromEnv(env)).toBe('s3');
    expect(applyRegistryStorageEnv(env, null)).toBe('DB_PASSWORD=x\n');
    expect(() => applyRegistryStorageEnv('', { ...S3, secretAccessKey: "it's" })).toThrow(/quotes/);
  });
});
