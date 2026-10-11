import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEGACY_UPDATES_BASE_URLS, UPDATES_BASE_URL } from '@/config/vendor-urls.js';
import { releaseArtifactSource } from '@/lib/release-artifacts.js';
import { type DaemonUpdateManifestPayload, verifyDaemonUpdateManifest } from '@/lib/update-artifact-trust.js';

// The host the release workflow stamps into signed manifests (scripts/release/manifest-download-base.sh).
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const stampedBase = /^MANIFEST_DOWNLOAD_BASE_URL="([^"]+)"$/m.exec(
  readFileSync(join(root, 'scripts/release/manifest-download-base.sh'), 'utf8')
)?.[1];

// The artifact base every install up to 2.11.4 uses (its env.ts default, not configurable per release).
const BASE_2_11 = 'https://updates.thesqlabs.com/gateway';

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
    keyId: 'wiolett-update-v1',
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, keys.privateKey).toString('base64url'),
  });
}

/** The daemon manifest check of a 2.11.4 backend: downloadUrl must equal the artifact under its own base. */
function verifyAs2114(signedManifest: string) {
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

  it('is accepted by a 2.11.4 backend, which customers update from straight to 2.12', () => {
    expect(stampedBase).toBe(BASE_2_11);
    expect(verifyAs2114(released).downloadUrl).toBe(`${BASE_2_11}/nginx-daemon/${tag}/${artifactName}`);
  });

  it('is accepted by 2.12 under either host name', () => {
    expect(LEGACY_UPDATES_BASE_URLS).toContain(BASE_2_11);
    expect(verifyAs212(released).downloadUrl).toBe(`${BASE_2_11}/nginx-daemon/${tag}/${artifactName}`);
    const onNewHost = manifest(`${UPDATES_BASE_URL}/nginx-daemon/${tag}/${artifactName}`);
    expect(verifyAs212(onNewHost).downloadUrl).toBe(`${UPDATES_BASE_URL}/nginx-daemon/${tag}/${artifactName}`);
  });

  it('would be refused by 2.11.4 on the new host, which is why the stamp waits', () => {
    expect(() => verifyAs2114(manifest(`${UPDATES_BASE_URL}/nginx-daemon/${tag}/${artifactName}`))).toThrow(
      'Update download URL mismatch'
    );
  });
});
