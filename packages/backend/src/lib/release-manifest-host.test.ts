import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { currentUpdatesUrl, LEGACY_UPDATES_BASE_URLS, UPDATES_BASE_URL } from '@/config/vendor-urls.js';
import { LEGACY_UPDATE_KEY_ID, LEGACY_UPDATES_BASE_URL } from '@/lib/legacy-compat.js';
import { releaseArtifactSource } from '@/lib/release-artifacts.js';
import { type DaemonUpdateManifestPayload, verifyDaemonUpdateManifest } from '@/lib/update-artifact-trust.js';

// The host the release workflow stamps into signed manifests (scripts/release/manifest-download-base.sh).
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const stampedBase = /^MANIFEST_DOWNLOAD_BASE_URL="([^"]+)"$/m.exec(
  readFileSync(join(root, 'scripts/release/manifest-download-base.sh'), 'utf8')
)?.[1];

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const tag = 'v2.12.6-nginx';
const artifactName = 'nginx-daemon-linux-amd64';

function manifest(downloadUrl: string): string {
  const payload: DaemonUpdateManifestPayload = {
    kind: 'daemon-binary',
    version: 'v2.12.6',
    tag,
    daemonType: 'nginx',
    arch: 'amd64',
    artifactName,
    downloadUrl,
    sha256: 'a'.repeat(64),
    createdAt: '2026-10-18T00:00:00Z',
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  return JSON.stringify({
    schemaVersion: 1,
    keyId: LEGACY_UPDATE_KEY_ID,
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, keys.privateKey).toString('base64url'),
  });
}

/** The daemon manifest check of a backend whose ARTIFACT_BASE_URL is base (2.12.5 and later run the same check). */
function verifyOn(base: string, signedManifest: string) {
  const source = releaseArtifactSource(base, 'nginx-daemon', tag, artifactName);
  return verifyDaemonUpdateManifest(
    signedManifest,
    {
      daemonType: 'nginx',
      version: 'v2.12.6',
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
  const stampedUrl = `${stampedBase}/nginx-daemon/${tag}/${artifactName}`;
  const released = manifest(stampedUrl);

  it('is the Opfield namespace of the update host', () => {
    expect(stampedBase).toBe(UPDATES_BASE_URL);
  });

  it('is accepted on the default artifact base and on an earlier one an install was set up with', () => {
    expect(verifyOn(UPDATES_BASE_URL, released).downloadUrl).toBe(stampedUrl);
    for (const base of LEGACY_UPDATES_BASE_URLS) expect(verifyOn(base, released).downloadUrl).toBe(stampedUrl);
  });

  it('still accepts a manifest signed under the earlier namespace', () => {
    const earlier = `${LEGACY_UPDATES_BASE_URL}/nginx-daemon/${tag}/${artifactName}`;
    expect(verifyOn(UPDATES_BASE_URL, manifest(earlier)).downloadUrl).toBe(earlier);
  });
});

describe('update service settings of an install set up with the earlier namespace', () => {
  it('read the Opfield namespace; a mirror is kept', () => {
    expect(currentUpdatesUrl(`${LEGACY_UPDATES_BASE_URL}/releases`)).toBe(`${UPDATES_BASE_URL}/releases`);
    expect(currentUpdatesUrl(LEGACY_UPDATES_BASE_URL)).toBe(UPDATES_BASE_URL);
    expect(currentUpdatesUrl('https://mirror.example/releases')).toBe('https://mirror.example/releases');
    expect(currentUpdatesUrl(undefined)).toBeUndefined();
  });
});
