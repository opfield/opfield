import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_UPDATES_BASE_URLS,
  OFFICIAL_IMAGE_REPOSITORIES,
  OFFICIAL_INFERENCE_CORE_IMAGE_REPOSITORIES,
  UPDATES_BASE_URL,
} from '@/config/vendor-urls.js';
import { gatewayInternalImageKind } from '@/modules/docker/docker-internal-images.js';
import {
  compareOpenCodexVersions,
  OPENCODEX_RELEASE_TAG_RE,
  OPENCODEX_VERSION_RE,
  parseOpenCodexVersion,
} from '@/modules/inference/core/inference-core.manifest.js';
import { coreUpdateInputSchema, coreVersionInputSchema } from '@/modules/inference/core/inference-core.routes.js';
import { releaseArtifactSource } from './release-artifacts.js';
import {
  verifyDaemonUpdateManifest,
  verifyGatewayImageManifest,
  verifyOpenCodexImageManifest,
  verifyRelayImageManifest,
} from './update-artifact-trust.js';

// 2.12 publishes under the Opfield names (ghcr.io/opfield/…, get.opfield.dev, -opfield.N core tags); the earlier
// names stay published as mirrors. It accepts both, and still accepts everything an earlier peer publishes or sends.

const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
const sha = 'a'.repeat(64);
const OLD_HOST = 'https://updates.thesqlabs.com/gateway';
const NEW_HOST = 'https://get.opfield.dev/gateway';
const OLD_REPO = 'ghcr.io/the-square-labs/gateway';
const NEW_REPO = 'ghcr.io/opfield/opfield';

function signed(payload: Record<string, unknown>): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  return JSON.stringify({
    schemaVersion: 1,
    keyId: 'wiolett-update-v1',
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, key.privateKey).toString('base64url'),
  });
}

function daemonManifest(downloadUrl: string): string {
  return signed({
    kind: 'daemon-binary',
    version: 'v2.12.0',
    tag: 'v2.12.0-docker',
    daemonType: 'docker',
    arch: 'amd64',
    artifactName: 'docker-daemon-linux-amd64',
    downloadUrl,
    sha256: sha,
    createdAt: '2026-10-11T00:00:00Z',
  });
}

function verifyDaemonFrom(artifactBaseUrl: string, downloadUrl: string) {
  const source = releaseArtifactSource(artifactBaseUrl, 'docker-daemon', 'v2.12.0-docker', 'docker-daemon-linux-amd64');
  return verifyDaemonUpdateManifest(
    daemonManifest(downloadUrl),
    {
      daemonType: 'docker',
      version: 'v2.12.0',
      tag: 'v2.12.0-docker',
      arch: 'amd64',
      artifactName: 'docker-daemon-linux-amd64',
      downloadUrl: source.artifactUrl,
      trustedPackagePrefix: source.trustedPrefix,
      acceptedDownloadUrls: source.acceptedArtifactUrls,
    },
    publicKey
  );
}

const ARTIFACT_PATH = '/docker-daemon/v2.12.0-docker/docker-daemon-linux-amd64';

describe('Opfield names', () => {
  it('uses the Opfield update host by default and keeps the earlier one', () => {
    expect(UPDATES_BASE_URL).toBe(NEW_HOST);
    expect(LEGACY_UPDATES_BASE_URLS).toEqual([OLD_HOST]);
    expect(OFFICIAL_IMAGE_REPOSITORIES).toEqual([NEW_REPO, OLD_REPO]);
    expect(OFFICIAL_INFERENCE_CORE_IMAGE_REPOSITORIES).toEqual([
      'ghcr.io/opfield/inference-core',
      'ghcr.io/the-square-labs/inference-core',
    ]);
  });

  describe('environment defaults', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    async function loadEnv(extra: Record<string, string> = {}) {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('DATABASE_URL', 'postgres://gateway:gateway@127.0.0.1:5432/gateway');
      vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
      vi.stubEnv('PKI_MASTER_KEY', 'a'.repeat(64));
      vi.stubEnv('SETUP_BOOTSTRAP', 'false');
      for (const name of [
        'RELEASES_API_URL',
        'ARTIFACT_BASE_URL',
        'GATEWAY_UPDATE_IMAGE_REPOSITORIES',
        'INFERENCE_CORE_UPDATE_IMAGE_REPOSITORIES',
        'SECURE_LINK_CONNECTOR_IMAGE',
      ]) {
        vi.stubEnv(name, undefined);
      }
      for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value);
      const { getEnv } = await import('@/config/env.js');
      return getEnv();
    }

    it('reads the feed from get.opfield.dev and accepts images from both repositories', async () => {
      const env = await loadEnv();
      expect(env.RELEASES_API_URL).toBe(`${NEW_HOST}/releases`);
      expect(env.ARTIFACT_BASE_URL).toBe(NEW_HOST);
      expect(env.GATEWAY_UPDATE_IMAGE_REPOSITORIES.split(',')).toEqual([NEW_REPO, OLD_REPO]);
      expect(env.INFERENCE_CORE_UPDATE_IMAGE_REPOSITORIES.split(',')).toEqual([
        'ghcr.io/opfield/inference-core',
        'ghcr.io/the-square-labs/inference-core',
      ]);
    });

    it('takes the feed from the earlier host when configured', async () => {
      const env = await loadEnv({ RELEASES_API_URL: `${OLD_HOST}/releases`, ARTIFACT_BASE_URL: OLD_HOST });
      expect(env.RELEASES_API_URL).toBe(`${OLD_HOST}/releases`);
      expect(env.ARTIFACT_BASE_URL).toBe(OLD_HOST);
    });

    it.each([
      `${OLD_REPO}/secure-link-connector:v2.11.5-relay`,
      `${NEW_REPO}/secure-link-connector:v2.12.0-relay`,
      `${NEW_REPO}/secure-link-connector:v2.12.0-rc.2-relay`,
    ])('accepts the official connector release tag %s in production', async (image) => {
      const env = await loadEnv({ SECURE_LINK_CONNECTOR_IMAGE: image });
      expect(env.SECURE_LINK_CONNECTOR_IMAGE).toBe(image);
    });

    it('still refuses a mutable connector tag outside the official repositories', async () => {
      await expect(
        loadEnv({ SECURE_LINK_CONNECTOR_IMAGE: 'ghcr.io/opfield/other/secure-link-connector:v2.12.0-relay' })
      ).rejects.toThrow('SECURE_LINK_CONNECTOR_IMAGE');
    });
  });
});

describe('Opfield names: daemon, relay supervisor and watchdog manifests', () => {
  it('accepts a manifest that names its artifact on get.opfield.dev, whichever host the feed is read from', () => {
    expect(verifyDaemonFrom(OLD_HOST, `${NEW_HOST}${ARTIFACT_PATH}`).downloadUrl).toBe(`${NEW_HOST}${ARTIFACT_PATH}`);
  });

  it('accepts a manifest signed before the move (updates.thesqlabs.com), whichever host the feed is read from', () => {
    expect(verifyDaemonFrom(OLD_HOST, `${OLD_HOST}${ARTIFACT_PATH}`).downloadUrl).toBe(`${OLD_HOST}${ARTIFACT_PATH}`);
    expect(verifyDaemonFrom(NEW_HOST, `${OLD_HOST}${ARTIFACT_PATH}`).downloadUrl).toBe(`${OLD_HOST}${ARTIFACT_PATH}`);
    expect(verifyDaemonFrom(NEW_HOST, `${NEW_HOST}${ARTIFACT_PATH}`).downloadUrl).toBe(`${NEW_HOST}${ARTIFACT_PATH}`);
  });

  it('refuses another host, another path or plain HTTP', () => {
    expect(() => verifyDaemonFrom(NEW_HOST, `https://get.example.com/gateway${ARTIFACT_PATH}`)).toThrow(
      'Update download URL mismatch'
    );
    expect(() =>
      verifyDaemonFrom(OLD_HOST, `${NEW_HOST}/docker-daemon/v2.12.0-docker/docker-daemon-linux-arm64`)
    ).toThrow('Update download URL mismatch');
    expect(() => verifyDaemonFrom(OLD_HOST, `http://get.opfield.dev/gateway${ARTIFACT_PATH}`)).toThrow(
      'Update download URL mismatch'
    );
    expect(() =>
      verifyDaemonFrom('http://mirror.internal/gateway', `http://mirror.internal/gateway${ARTIFACT_PATH}`)
    ).toThrow('Update download URL is not trusted');
  });
});

describe('Opfield names: Gateway and Relay image manifests', () => {
  function gatewayManifest(repository: string) {
    return signed({
      kind: 'gateway-image',
      version: 'v2.12.0',
      tag: 'v2.12.0',
      image: repository,
      digest: `sha256:${sha}`,
      imageRef: `${repository}@sha256:${sha}`,
      secureLinkConnectorImage: `${repository}/secure-link-connector@sha256:${sha}`,
      createdAt: '2026-10-11T00:00:00Z',
    });
  }

  function relayManifest(repository: string) {
    return signed({
      kind: 'relay-image',
      version: 'v2.12.0',
      tag: 'v2.12.0-relay',
      image: `${repository}/relay`,
      digest: `sha256:${sha}`,
      imageRef: `${repository}/relay@sha256:${sha}`,
      protocolMajor: 1,
      minGatewayVersion: 'v2.11.5',
      secureLinkConnectorImage: `${repository}/secure-link-connector@sha256:${sha}`,
      createdAt: '2026-10-11T00:00:00Z',
    });
  }

  it.each([OLD_REPO, NEW_REPO])('verifies a Gateway and a Relay manifest naming %s', (repository) => {
    const gateway = verifyGatewayImageManifest(
      gatewayManifest(repository),
      { version: 'v2.12.0', tag: 'v2.12.0', image: repository },
      publicKey
    );
    expect(gateway.imageRef).toBe(`${repository}@sha256:${sha}`);
    expect(gateway.secureLinkConnectorImage).toBe(`${repository}/secure-link-connector@sha256:${sha}`);
    const relay = verifyRelayImageManifest(
      relayManifest(repository),
      { version: 'v2.12.0', tag: 'v2.12.0-relay', image: `${repository}/relay`, protocolMajor: 1 },
      publicKey
    );
    expect(relay.secureLinkConnectorImage).toBe(`${repository}/secure-link-connector@sha256:${sha}`);
  });

  it('keeps the connector bound to the repository the manifest names', () => {
    const mixed = signed({
      kind: 'relay-image',
      version: 'v2.12.0',
      tag: 'v2.12.0-relay',
      image: `${NEW_REPO}/relay`,
      digest: `sha256:${sha}`,
      imageRef: `${NEW_REPO}/relay@sha256:${sha}`,
      protocolMajor: 1,
      secureLinkConnectorImage: `ghcr.io/opfield/other/secure-link-connector@sha256:${sha}`,
      createdAt: '2026-10-11T00:00:00Z',
    });
    expect(() =>
      verifyRelayImageManifest(
        mixed,
        { version: 'v2.12.0', tag: 'v2.12.0-relay', image: `${NEW_REPO}/relay`, protocolMajor: 1 },
        publicKey
      )
    ).toThrow('secure-link connector image reference is not digest pinned');
  });

  it.each([
    [`${OLD_REPO}/secure-link-connector`, 'secure-link-connector'],
    [`${NEW_REPO}/secure-link-connector`, 'secure-link-connector'],
    [`${NEW_REPO}/database-connector`, 'database-connector'],
    ['registry.example.com/wiolett/gateway/secure-link-connector', 'secure-link-connector'],
    ['ghcr.io/opfield/other/secure-link-connector', null],
  ])('classifies %s as a Gateway internal image: %s', (repository, kind) => {
    expect(gatewayInternalImageKind({ RepoDigests: [`${repository}@sha256:${sha}`] })).toBe(kind);
  });
});

describe('Opfield names: inference core', () => {
  it('parses the wiolett, thesqlabs and opfield release lines', () => {
    for (const tag of ['v2.25.0-wiolett.27', 'v2.60.6-thesqlabs.6', 'v2.61.0-opfield.1']) {
      expect(OPENCODEX_RELEASE_TAG_RE.test(tag)).toBe(true);
      expect(OPENCODEX_VERSION_RE.test(tag.slice(1))).toBe(true);
      expect(parseOpenCodexVersion(tag)).not.toBeNull();
      expect(coreUpdateInputSchema.safeParse({ version: tag.slice(1) }).success).toBe(true);
      expect(coreVersionInputSchema.safeParse({ version: tag.slice(1) }).success).toBe(true);
    }
    expect(OPENCODEX_RELEASE_TAG_RE.test('v2.61.0-other.1')).toBe(false);
    expect(OPENCODEX_RELEASE_TAG_RE.test('v2.61.0-opfield')).toBe(false);
    expect(coreUpdateInputSchema.safeParse({ version: '2.61.0-other.1' }).success).toBe(false);
  });

  it('orders the opfield line after thesqlabs', () => {
    expect(compareOpenCodexVersions('2.61.0-opfield.1', '2.60.6-thesqlabs.6')).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('v2.60.6-thesqlabs.6', 'v2.61.0-opfield.1')).toBeLessThan(0);
    expect(compareOpenCodexVersions('2.60.0-opfield.1', '2.60.0-thesqlabs.9')).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('2.60.0-thesqlabs.1', '2.60.0-wiolett.40')).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('2.60.0-opfield.2', '2.60.0-opfield.10')).toBeLessThan(0);
    expect(compareOpenCodexVersions('2.61.0-opfield.3', 'v2.61.0-opfield.3')).toBe(0);
  });

  it.each(OFFICIAL_INFERENCE_CORE_IMAGE_REPOSITORIES)('verifies an -opfield core manifest naming %s', (image) => {
    const manifest = signed({
      kind: 'opencodex-image',
      version: '2.61.0-opfield.1',
      tag: 'v2.61.0-opfield.1',
      image,
      digest: `sha256:${sha}`,
      imageRef: `${image}@sha256:${sha}`,
      sizeBytes: 412345678,
      coreProtocolMajor: 1,
      stateSchemaVersion: 1,
      minGatewayVersion: 'v2.10.2',
      buildRevision: 'abc123',
      createdAt: '2026-10-11T00:00:00Z',
    });
    const artifact = verifyOpenCodexImageManifest(
      manifest,
      { image, coreProtocolMajor: 1, version: '2.61.0-opfield.1', tag: 'v2.61.0-opfield.1' },
      publicKey
    );
    expect(artifact.version).toBe('2.61.0-opfield.1');
  });
});
