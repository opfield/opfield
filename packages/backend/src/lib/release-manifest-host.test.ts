import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEGACY_UPDATES_BASE_URLS, UPDATES_BASE_URL } from '@/config/vendor-urls.js';
import {
  LEGACY_THESQLABS_UPDATES_BASE_URL,
  LEGACY_UPDATE_KEY_ID,
  LEGACY_UPDATE_NAMESPACE,
  LEGACY_UPDATES_BASE_URL,
} from '@/lib/legacy-compat.js';
import { releaseArtifactSource } from '@/lib/release-artifacts.js';
import { type DaemonUpdateManifestPayload, verifyDaemonUpdateManifest } from '@/lib/update-artifact-trust.js';

// The host the release workflow stamps into signed manifests (scripts/release/manifest-download-base.sh).
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const stampedBase = /^MANIFEST_DOWNLOAD_BASE_URL="([^"]+)"$/m
  .exec(readFileSync(join(root, 'scripts/release/manifest-download-base.sh'), 'utf8'))?.[1]
  ?.replace('${LEGACY_UPDATE_NAMESPACE}', LEGACY_UPDATE_NAMESPACE);

// The artifact base installs up to 2.11.5 read by default (their env.ts default, not configurable per release).
const BASE_2_11 = LEGACY_THESQLABS_UPDATES_BASE_URL;

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const tag = 'v2.12.0-nginx';
const artifactName = 'nginx-daemon-linux-amd64';

function manifest(downloadUrl: string): string {
  const payload: DaemonUpdateManifestPayload = {
    kind: 'daemon-binary',
    version: 'v2.12.0',
    tag,
    daemonType: 'nginx',
    arch: 'amd64',
    artifactName,
    downloadUrl,
    sha256: 'a'.repeat(64),
    createdAt: '2026-10-11T00:00:00Z',
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  return JSON.stringify({
    schemaVersion: 1,
    keyId: LEGACY_UPDATE_KEY_ID,
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, keys.privateKey).toString('base64url'),
  });
}

/**
 * The daemon manifest check of a 2.11 backend on its default base. 2.11.5 accepts the artifact under every name of the
 * update host (`acceptedDownloadUrls`, the same check as 2.12); 2.11.4 only under its own base.
 */
function verifyAs211(signedManifest: string, bridge: boolean) {
  const source = releaseArtifactSource(BASE_2_11, 'nginx-daemon', tag, artifactName);
  return verifyDaemonUpdateManifest(
    signedManifest,
    {
      daemonType: 'nginx',
      version: 'v2.12.0',
      tag,
      arch: 'amd64',
      artifactName,
      downloadUrl: source.artifactUrl,
      trustedPackagePrefix: source.trustedPrefix,
      ...(bridge ? { acceptedDownloadUrls: source.acceptedArtifactUrls } : {}),
    },
    publicKey
  );
}

function verifyAs212(signedManifest: string) {
  const source = releaseArtifactSource(UPDATES_BASE_URL, 'nginx-daemon', tag, artifactName);
  return verifyDaemonUpdateManifest(
    signedManifest,
    {
      daemonType: 'nginx',
      version: 'v2.12.0',
      tag,
      arch: 'amd64',
      artifactName,
      downloadUrl: source.artifactUrl,
      trustedPackagePrefix: source.trustedPrefix,
      acceptedDownloadUrls: source.acceptedArtifactUrls,
    },
    publicKey
  );
}

describe('host stamped into release manifests', () => {
  const released = manifest(`${stampedBase}/nginx-daemon/${tag}/${artifactName}`);

  it('is the Opfield update host', () => {
    expect(stampedBase).toBe(LEGACY_UPDATES_BASE_URL);
    expect(LEGACY_UPDATES_BASE_URLS).toContain(stampedBase);
  });

  it('is accepted by a 2.11.5 backend on its default base, which every 2.11 install updates through', () => {
    expect(verifyAs211(released, true).downloadUrl).toBe(`${stampedBase}/nginx-daemon/${tag}/${artifactName}`);
  });

  it('is accepted by 2.12 under either host name', () => {
    expect(LEGACY_UPDATES_BASE_URLS).toContain(BASE_2_11);
    expect(verifyAs212(released).downloadUrl).toBe(`${stampedBase}/nginx-daemon/${tag}/${artifactName}`);
    const onOldHost = manifest(`${BASE_2_11}/nginx-daemon/${tag}/${artifactName}`);
    expect(verifyAs212(onOldHost).downloadUrl).toBe(`${BASE_2_11}/nginx-daemon/${tag}/${artifactName}`);
  });

  it('is refused by a 2.11.4 backend, which has to update to 2.11.5 first', () => {
    expect(() => verifyAs211(released, false)).toThrow('Update download URL mismatch');
  });
});
