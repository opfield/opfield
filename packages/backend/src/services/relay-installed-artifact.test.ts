import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@/config/env.js';
import {
  applyNewerInstalledRelayArtifact,
  loadInstalledRelayArtifact,
  parseInstalledRelayArtifact,
  saveInstalledRelayArtifact,
} from './relay-installed-artifact.js';

const artifact = {
  imageRef: `registry.example.com/relay@sha256:${'a'.repeat(64)}`,
  buildVersion: 'v2.9.16',
  protocolMajor: 1,
  secureLinkConnectorImage: `registry.example.com/connector@sha256:${'b'.repeat(64)}`,
};

describe('installed Relay artifact persistence', () => {
  it('restores a newer managed Relay artifact over stale container environment', () => {
    const env = {
      OPFIELD_RELAY_IMAGE_REF: `registry.example.com/relay@sha256:${'c'.repeat(64)}`,
      OPFIELD_RELAY_BUILD_VERSION: 'v2.9.12',
      OPFIELD_RELAY_PROTOCOL_MAJOR: 1,
      SECURE_LINK_CONNECTOR_IMAGE: `registry.example.com/connector@sha256:${'d'.repeat(64)}`,
    } as Env;

    expect(applyNewerInstalledRelayArtifact(env, artifact)).toBe(true);
    expect(env).toMatchObject({
      OPFIELD_RELAY_IMAGE_REF: artifact.imageRef,
      OPFIELD_RELAY_BUILD_VERSION: artifact.buildVersion,
      OPFIELD_RELAY_PROTOCOL_MAJOR: artifact.protocolMajor,
      SECURE_LINK_CONNECTOR_IMAGE: artifact.secureLinkConnectorImage,
    });
  });

  it('does not replace an equal or newer installer configuration', () => {
    for (const configuredVersion of ['v2.9.16', 'v2.10.0']) {
      const env = { OPFIELD_RELAY_BUILD_VERSION: configuredVersion } as Env;
      expect(applyNewerInstalledRelayArtifact(env, artifact)).toBe(false);
      expect(env.OPFIELD_RELAY_BUILD_VERSION).toBe(configuredVersion);
    }
  });

  it('rejects unpinned or malformed persisted artifacts', () => {
    expect(parseInstalledRelayArtifact({ ...artifact, imageRef: 'registry.example.com/relay:latest' })).toBeNull();
    expect(parseInstalledRelayArtifact({ ...artifact, protocolMajor: 0 })).toBeNull();
    expect(parseInstalledRelayArtifact({ ...artifact, buildVersion: 'not-semver' })).toBeNull();
  });

  it('loads and atomically upserts the installed artifact', async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ value: artifact }]) })),
        })),
      })),
      insert: vi.fn(() => ({ values })),
    };

    await expect(loadInstalledRelayArtifact(db as never)).resolves.toEqual(artifact);
    await expect(saveInstalledRelayArtifact(db as never, artifact)).resolves.toBeUndefined();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ value: artifact }));
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.objectContaining({ value: artifact }) })
    );
  });
});
