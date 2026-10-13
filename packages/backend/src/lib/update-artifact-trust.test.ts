import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isDigestPinnedImageRef,
  normalizeGitLabApiUrl,
  trustedGitLabPackagePrefix,
  UpdateArtifactTrustError,
  verifyDaemonUpdateManifest,
  verifyOpenCodexImageManifest,
  verifyOpfieldImageManifest,
  verifyRelayImageManifest,
} from './update-artifact-trust.js';

const checksum = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const daemonUrl =
  'https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64';
const daemonManifest = `{
  "schemaVersion": 1,
  "keyId": "wiolett-update-v1",
  "payload": "eyJraW5kIjoiZGFlbW9uLWJpbmFyeSIsInZlcnNpb24iOiJ2OS45LjkiLCJ0YWciOiJ2OS45LjktbmdpbngiLCJkYWVtb25UeXBlIjoibmdpbngiLCJhcmNoIjoiYW1kNjQiLCJhcnRpZmFjdE5hbWUiOiJuZ2lueC1kYWVtb24tbGludXgtYW1kNjQiLCJkb3dubG9hZFVybCI6Imh0dHBzOi8vZ2l0bGFiLndpb2xldHQubmV0L2FwaS92NC9wcm9qZWN0cy93aW9sZXR0JTJGZ2F0ZXdheS9wYWNrYWdlcy9nZW5lcmljL25naW54LWRhZW1vbi92OS45LjktbmdpbngvbmdpbngtZGFlbW9uLWxpbnV4LWFtZDY0Iiwic2hhMjU2IjoiMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZiIsImNyZWF0ZWRBdCI6IjIwMjYtMDUtMDJUMTQ6Mzk6MDNaIiwiZ2l0Q29tbWl0U2hhIjoidGVzdCIsImdpdFBpcGVsaW5lSWQiOiIxIn0",
  "signature": "sNy92HOZyOUMyGJkXQ1nRmTSFm3BosuaAUaInP_Svo0cWGx50jvMlnsfU64FyubGDXK4ihvpgtlcNCfqN61ABw"
}`;
const opfieldSigningKey = generateKeyPairSync('ed25519');
const opfieldPayload = Buffer.from(
  JSON.stringify({
    kind: 'gateway-image',
    version: 'v9.9.9',
    tag: 'v9.9.9',
    image: 'registry.gitlab.wiolett.net/wiolett/gateway',
    digest: `sha256:${checksum}`,
    imageRef: `registry.gitlab.wiolett.net/wiolett/gateway@sha256:${checksum}`,
    secureLinkConnectorImage: `registry.gitlab.wiolett.net/wiolett/gateway/secure-link-connector@sha256:${checksum}`,
    createdAt: '2026-05-02T14:39:10Z',
  })
);
const opfieldManifest = JSON.stringify({
  schemaVersion: 1,
  keyId: 'wiolett-update-v1',
  payload: opfieldPayload.toString('base64url'),
  signature: sign(null, opfieldPayload, opfieldSigningKey.privateKey).toString('base64url'),
});
const opfieldPublicKey = opfieldSigningKey.publicKey.export({ type: 'spki', format: 'pem' });
const relayPayload = Buffer.from(
  JSON.stringify({
    kind: 'relay-image',
    version: 'v1.2.3',
    tag: 'v1.2.3-relay',
    image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
    digest: `sha256:${checksum}`,
    imageRef: `registry.gitlab.wiolett.net/wiolett/gateway/relay@sha256:${checksum}`,
    protocolMajor: 1,
    minGatewayVersion: 'v1.2.0',
    secureLinkConnectorImage: `registry.gitlab.wiolett.net/wiolett/gateway/secure-link-connector@sha256:${checksum}`,
    createdAt: '2026-05-02T14:39:10Z',
  })
);
const relayManifest = JSON.stringify({
  schemaVersion: 1,
  keyId: 'wiolett-update-v1',
  payload: relayPayload.toString('base64url'),
  signature: sign(null, relayPayload, opfieldSigningKey.privateKey).toString('base64url'),
});
const opencodexPayload = Buffer.from(
  JSON.stringify({
    kind: 'opencodex-image',
    version: '2.26.0-wiolett.1',
    tag: 'v2.26.0-wiolett.1',
    image: 'registry.gitlab.wiolett.net/wiolett/gateway/opencodex',
    digest: `sha256:${checksum}`,
    imageRef: `registry.gitlab.wiolett.net/wiolett/gateway/opencodex@sha256:${checksum}`,
    sizeBytes: 412345678,
    coreProtocolMajor: 1,
    stateSchemaVersion: 1,
    minGatewayVersion: 'v2.6.0',
    releaseNotesUrl: 'https://docs.wiolett.net/releases/opencodex-2.26.0-wiolett.1',
    buildRevision: 'cd762f832',
    createdAt: '2026-08-19T00:00:00.000Z',
  })
);
const opencodexManifest = JSON.stringify({
  schemaVersion: 1,
  keyId: 'wiolett-update-v1',
  payload: opencodexPayload.toString('base64url'),
  signature: sign(null, opencodexPayload, opfieldSigningKey.privateKey).toString('base64url'),
});

describe('update artifact trust', () => {
  it('normalizes GitLab API base URLs for exact signed URL comparisons', () => {
    expect(normalizeGitLabApiUrl('https://gitlab.wiolett.net/')).toBe('https://gitlab.wiolett.net');
    expect(trustedGitLabPackagePrefix('https://gitlab.wiolett.net/', 'wiolett/gateway')).toBe(
      'https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/'
    );
  });

  it('verifies a daemon update manifest for the expected artifact', () => {
    const artifact = verifyDaemonUpdateManifest(daemonManifest, {
      daemonType: 'nginx',
      version: 'v9.9.9',
      tag: 'v9.9.9-nginx',
      arch: 'amd64',
      artifactName: 'nginx-daemon-linux-amd64',
      downloadUrl: daemonUrl,
      trustedPackagePrefix: trustedGitLabPackagePrefix('https://gitlab.wiolett.net', 'wiolett/gateway'),
    });

    expect(artifact.checksum).toBe(checksum);
    expect(artifact.downloadUrl).toBe(daemonUrl);
  });

  it('accepts a daemon manifest that names the artifact under an earlier name of the update host', () => {
    const expected = {
      daemonType: 'nginx' as const,
      version: 'v9.9.9',
      tag: 'v9.9.9-nginx',
      arch: 'amd64',
      artifactName: 'nginx-daemon-linux-amd64',
      downloadUrl: 'https://get.opfield.dev/gateway/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64',
      trustedPackagePrefix: 'https://get.opfield.dev/gateway/',
    };

    expect(() => verifyDaemonUpdateManifest(daemonManifest, expected)).toThrow('Update download URL mismatch');
    expect(
      verifyDaemonUpdateManifest(daemonManifest, {
        ...expected,
        acceptedDownloadUrls: [expected.downloadUrl, daemonUrl],
      }).downloadUrl
    ).toBe(daemonUrl);
  });

  it('rejects daemon manifests for the wrong architecture', () => {
    expect(() =>
      verifyDaemonUpdateManifest(daemonManifest, {
        daemonType: 'nginx',
        version: 'v9.9.9',
        tag: 'v9.9.9-nginx',
        arch: 'arm64',
        artifactName: 'nginx-daemon-linux-amd64',
        downloadUrl: daemonUrl,
        trustedPackagePrefix: trustedGitLabPackagePrefix('https://gitlab.wiolett.net', 'wiolett/gateway'),
      })
    ).toThrow(UpdateArtifactTrustError);
  });

  it('rejects manifests with tampered payload bytes', () => {
    const envelope = JSON.parse(daemonManifest) as { payload: string };
    envelope.payload = Buffer.from('{"kind":"daemon-binary"}').toString('base64url');

    expect(() =>
      verifyDaemonUpdateManifest(JSON.stringify(envelope), {
        daemonType: 'nginx',
        version: 'v9.9.9',
        tag: 'v9.9.9-nginx',
        arch: 'amd64',
        artifactName: 'nginx-daemon-linux-amd64',
        downloadUrl: daemonUrl,
        trustedPackagePrefix: trustedGitLabPackagePrefix('https://gitlab.wiolett.net', 'wiolett/gateway'),
      })
    ).toThrow(UpdateArtifactTrustError);
  });

  it('verifies a gateway image manifest with a digest-pinned image reference', () => {
    const artifact = verifyOpfieldImageManifest(
      opfieldManifest,
      {
        version: 'v9.9.9',
        tag: 'v9.9.9',
        image: 'registry.gitlab.wiolett.net/wiolett/gateway',
      },
      opfieldPublicKey
    );

    expect(artifact.imageRef).toBe(`registry.gitlab.wiolett.net/wiolett/gateway@sha256:${checksum}`);
    expect('databaseConnectorImage' in artifact).toBe(false);
    expect(artifact.secureLinkConnectorImage).toContain('/secure-link-connector@sha256:');
  });

  it('verifies an independently signed digest-pinned relay image', () => {
    const artifact = verifyRelayImageManifest(
      relayManifest,
      {
        version: 'v1.2.3',
        tag: 'v1.2.3-relay',
        image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
        protocolMajor: 1,
      },
      opfieldPublicKey
    );

    expect(artifact.buildVersion).toBe('v1.2.3');
    expect(artifact.protocolMajor).toBe(1);
    expect(artifact.minGatewayVersion).toBe('v1.2.0');
    expect(artifact.imageRef).toContain('/relay@sha256:');
    expect('databaseConnectorImage' in artifact).toBe(false);
    expect(artifact.secureLinkConnectorImage).toContain('/secure-link-connector@sha256:');
  });

  it('verifies a release-candidate Relay manifest and Opfield compatibility floor', () => {
    const payload = Buffer.from(
      JSON.stringify({
        kind: 'relay-image',
        version: 'v2.10.0-rc.2',
        tag: 'v2.10.0-rc.2-relay',
        image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
        digest: `sha256:${checksum}`,
        imageRef: `registry.gitlab.wiolett.net/wiolett/gateway/relay@sha256:${checksum}`,
        protocolMajor: 1,
        minGatewayVersion: 'v2.10.0-rc.1',
        secureLinkConnectorImage: `registry.gitlab.wiolett.net/wiolett/gateway/secure-link-connector@sha256:${checksum}`,
        createdAt: '2026-08-30T00:00:00.000Z',
      })
    );
    const manifest = JSON.stringify({
      schemaVersion: 1,
      keyId: 'wiolett-update-v1',
      payload: payload.toString('base64url'),
      signature: sign(null, payload, opfieldSigningKey.privateKey).toString('base64url'),
    });

    const artifact = verifyRelayImageManifest(
      manifest,
      {
        version: 'v2.10.0-rc.2',
        tag: 'v2.10.0-rc.2-relay',
        image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
        protocolMajor: 1,
      },
      opfieldPublicKey
    );

    expect(artifact.buildVersion).toBe('v2.10.0-rc.2');
    expect(artifact.minGatewayVersion).toBe('v2.10.0-rc.1');
  });

  it('uses the signed Relay version as the compatibility floor for legacy manifests', () => {
    const payload = Buffer.from(
      JSON.stringify({
        kind: 'relay-image',
        version: 'v1.2.3',
        tag: 'v1.2.3-relay',
        image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
        digest: `sha256:${checksum}`,
        imageRef: `registry.gitlab.wiolett.net/wiolett/gateway/relay@sha256:${checksum}`,
        protocolMajor: 1,
        databaseConnectorImage: `registry.gitlab.wiolett.net/wiolett/gateway/database-connector@sha256:${checksum}`,
        secureLinkConnectorImage: `registry.gitlab.wiolett.net/wiolett/gateway/secure-link-connector@sha256:${checksum}`,
        createdAt: '2026-08-17T00:00:00.000Z',
      })
    );
    const manifest = JSON.stringify({
      schemaVersion: 1,
      keyId: 'wiolett-update-v1',
      payload: payload.toString('base64url'),
      signature: sign(null, payload, opfieldSigningKey.privateKey).toString('base64url'),
    });

    const artifact = verifyRelayImageManifest(
      manifest,
      {
        version: 'v1.2.3',
        tag: 'v1.2.3-relay',
        image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
        protocolMajor: 1,
      },
      opfieldPublicKey
    );

    expect(artifact.minGatewayVersion).toBe('v1.2.3');
  });

  it('rejects a mutable Secure Link connector image in a Relay manifest', () => {
    const payload = Buffer.from(
      JSON.stringify({
        kind: 'relay-image',
        version: 'v1.2.3',
        tag: 'v1.2.3-relay',
        image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
        digest: `sha256:${checksum}`,
        imageRef: `registry.gitlab.wiolett.net/wiolett/gateway/relay@sha256:${checksum}`,
        protocolMajor: 1,
        databaseConnectorImage: `registry.gitlab.wiolett.net/wiolett/gateway/database-connector@sha256:${checksum}`,
        secureLinkConnectorImage: 'registry.gitlab.wiolett.net/wiolett/gateway/secure-link-connector:latest',
        createdAt: '2026-08-17T00:00:00.000Z',
      })
    );
    const manifest = JSON.stringify({
      schemaVersion: 1,
      keyId: 'wiolett-update-v1',
      payload: payload.toString('base64url'),
      signature: sign(null, payload, opfieldSigningKey.privateKey).toString('base64url'),
    });

    expect(() =>
      verifyRelayImageManifest(
        manifest,
        {
          version: 'v1.2.3',
          tag: 'v1.2.3-relay',
          image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
          protocolMajor: 1,
        },
        opfieldPublicKey
      )
    ).toThrow('Relay update secure-link connector image reference is not digest pinned');
  });

  it('rejects a mutable database connector image in a Relay manifest', () => {
    const payload = Buffer.from(
      JSON.stringify({
        kind: 'relay-image',
        version: 'v1.2.3',
        tag: 'v1.2.3-relay',
        image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
        digest: `sha256:${checksum}`,
        imageRef: `registry.gitlab.wiolett.net/wiolett/gateway/relay@sha256:${checksum}`,
        protocolMajor: 1,
        databaseConnectorImage: 'registry.gitlab.wiolett.net/wiolett/gateway/database-connector:latest',
        secureLinkConnectorImage: `registry.gitlab.wiolett.net/wiolett/gateway/secure-link-connector@sha256:${checksum}`,
        createdAt: '2026-08-17T00:00:00.000Z',
      })
    );
    const manifest = JSON.stringify({
      schemaVersion: 1,
      keyId: 'wiolett-update-v1',
      payload: payload.toString('base64url'),
      signature: sign(null, payload, opfieldSigningKey.privateKey).toString('base64url'),
    });

    expect(() =>
      verifyRelayImageManifest(
        manifest,
        {
          version: 'v1.2.3',
          tag: 'v1.2.3-relay',
          image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
          protocolMajor: 1,
        },
        opfieldPublicKey
      )
    ).toThrow('Relay update database connector image reference is not digest pinned');
  });

  it('rejects a relay manifest with an incompatible protocol major', () => {
    expect(() =>
      verifyRelayImageManifest(
        relayManifest,
        {
          version: 'v1.2.3',
          tag: 'v1.2.3-relay',
          image: 'registry.gitlab.wiolett.net/wiolett/gateway/relay',
          protocolMajor: 2,
        },
        opfieldPublicKey
      )
    ).toThrow('Relay update protocol major is incompatible');
  });

  it('rejects gateway manifests for a different image repository', () => {
    expect(() =>
      verifyOpfieldImageManifest(
        opfieldManifest,
        {
          version: 'v9.9.9',
          tag: 'v9.9.9',
          image: 'registry.example.com/wiolett/gateway',
        },
        opfieldPublicKey
      )
    ).toThrow(UpdateArtifactTrustError);
  });

  it('accepts only a digest-pinned Secure Link connector image in the Opfield repository', () => {
    const repository = 'registry.gitlab.wiolett.net/wiolett/gateway/secure-link-connector';
    expect(isDigestPinnedImageRef(`${repository}@sha256:${checksum}`, repository)).toBe(true);
    expect(isDigestPinnedImageRef(`${repository}:v2.5.0`, repository)).toBe(false);
    expect(isDigestPinnedImageRef(`registry.example.com/connector@sha256:${checksum}`, repository)).toBe(false);
  });

  it('rejects a mutable Secure Link connector image even when the manifest signature is valid', () => {
    const payload = Buffer.from(
      JSON.stringify({
        kind: 'gateway-image',
        version: 'v9.9.9',
        tag: 'v9.9.9',
        image: 'registry.gitlab.wiolett.net/wiolett/gateway',
        digest: `sha256:${checksum}`,
        imageRef: `registry.gitlab.wiolett.net/wiolett/gateway@sha256:${checksum}`,
        secureLinkConnectorImage: 'registry.gitlab.wiolett.net/wiolett/gateway/secure-link-connector:latest',
        createdAt: '2026-08-10T00:00:00.000Z',
      })
    );
    const manifest = JSON.stringify({
      schemaVersion: 1,
      keyId: 'wiolett-update-v1',
      payload: payload.toString('base64url'),
      signature: sign(null, payload, opfieldSigningKey.privateKey).toString('base64url'),
    });

    expect(() =>
      verifyOpfieldImageManifest(
        manifest,
        {
          version: 'v9.9.9',
          tag: 'v9.9.9',
          image: 'registry.gitlab.wiolett.net/wiolett/gateway',
        },
        opfieldPublicKey
      )
    ).toThrow('Opfield update secure-link connector image reference is not digest pinned');
  });

  it('rejects an invalid relay version even when the manifest signature is valid', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const payload = Buffer.from(
      JSON.stringify({
        kind: 'relay-image',
        version: '../mutable',
        tag: '../mutable-relay',
        image: 'registry.example/gateway/relay',
        digest: `sha256:${checksum}`,
        imageRef: `registry.example/gateway/relay@sha256:${checksum}`,
        protocolMajor: 1,
        createdAt: '2026-08-07T00:00:00.000Z',
      })
    );
    const envelope = JSON.stringify({
      schemaVersion: 1,
      keyId: 'wiolett-update-v1',
      payload: payload.toString('base64url'),
      signature: sign(null, payload, privateKey).toString('base64url'),
    });

    expect(() =>
      verifyRelayImageManifest(
        envelope,
        { version: '../mutable', tag: '../mutable-relay', image: 'registry.example/gateway/relay', protocolMajor: 1 },
        publicKey.export({ type: 'spki', format: 'pem' })
      )
    ).toThrow('Relay update build version is invalid');
  });

  it('verifies an OpenCodex image manifest with digest, size, and protocol identity', () => {
    const artifact = verifyOpenCodexImageManifest(
      opencodexManifest,
      {
        image: 'registry.gitlab.wiolett.net/wiolett/gateway/opencodex',
        coreProtocolMajor: 1,
      },
      opfieldPublicKey
    );

    expect(artifact.version).toBe('2.26.0-wiolett.1');
    expect(artifact.digest).toBe(`sha256:${checksum}`);
    expect(artifact.imageRef).toBe(`registry.gitlab.wiolett.net/wiolett/gateway/opencodex@sha256:${checksum}`);
    expect(artifact.sizeBytes).toBe(412345678);
    expect(artifact.coreProtocolMajor).toBe(1);
    expect(artifact.stateSchemaVersion).toBe(1);
    expect(artifact.minOpfieldVersion).toBe('v2.6.0');
    expect(artifact.releaseNotesUrl).toBe('https://docs.wiolett.net/releases/opencodex-2.26.0-wiolett.1');
  });

  it('rejects an OpenCodex manifest pinned to a different version', () => {
    expect(() =>
      verifyOpenCodexImageManifest(
        opencodexManifest,
        {
          image: 'registry.gitlab.wiolett.net/wiolett/gateway/opencodex',
          coreProtocolMajor: 1,
          version: '2.26.0-wiolett.2',
        },
        opfieldPublicKey
      )
    ).toThrow('OpenCodex update version mismatch');
  });

  it('rejects an OpenCodex manifest with an incompatible core protocol major', () => {
    expect(() =>
      verifyOpenCodexImageManifest(
        opencodexManifest,
        {
          image: 'registry.gitlab.wiolett.net/wiolett/gateway/opencodex',
          coreProtocolMajor: 2,
        },
        opfieldPublicKey
      )
    ).toThrow('OpenCodex core protocol major is incompatible');
  });

  it('rejects an OpenCodex manifest from a foreign image repository', () => {
    expect(() =>
      verifyOpenCodexImageManifest(
        opencodexManifest,
        {
          image: 'registry.example.com/wiolett/opencodex',
          coreProtocolMajor: 1,
        },
        opfieldPublicKey
      )
    ).toThrow('OpenCodex update image mismatch');
  });

  it('rejects an OpenCodex manifest whose version is not an Opfield release', () => {
    const payload = Buffer.from(
      JSON.stringify({
        kind: 'opencodex-image',
        version: '2.26.0',
        tag: 'v2.26.0',
        image: 'registry.gitlab.wiolett.net/wiolett/gateway/opencodex',
        digest: `sha256:${checksum}`,
        imageRef: `registry.gitlab.wiolett.net/wiolett/gateway/opencodex@sha256:${checksum}`,
        sizeBytes: 412345678,
        coreProtocolMajor: 1,
        stateSchemaVersion: 1,
        buildRevision: 'cd762f832',
        createdAt: '2026-08-19T00:00:00.000Z',
      })
    );
    const manifest = JSON.stringify({
      schemaVersion: 1,
      keyId: 'wiolett-update-v1',
      payload: payload.toString('base64url'),
      signature: sign(null, payload, opfieldSigningKey.privateKey).toString('base64url'),
    });

    expect(() =>
      verifyOpenCodexImageManifest(
        manifest,
        {
          image: 'registry.gitlab.wiolett.net/wiolett/gateway/opencodex',
          coreProtocolMajor: 1,
        },
        opfieldPublicKey
      )
    ).toThrow('OpenCodex update version is not an Opfield release');
  });
});
