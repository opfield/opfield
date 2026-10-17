import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { currentWitnessVersion, WITNESS_ARTIFACTS, WitnessCatalog } from './witness-catalog.js';
import { LEGACY_UPDATE_KEY_ID } from '@/lib/legacy-compat.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const BASE = 'https://updates.example/opfield';
const SHA = 'c'.repeat(64);

function manifest(payload: Record<string, unknown>, key = privateKey): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  return JSON.stringify({
    schemaVersion: 1,
    keyId: LEGACY_UPDATE_KEY_ID,
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, key).toString('base64url'),
  });
}

const artifactName = 'witness-clickhouse-keeper-25.8.28.1-linux-arm64';
const downloadUrl = `${BASE}/witness-clickhouse-keeper/v2.12.0/${artifactName}`;
const good = {
  kind: 'witness-binary',
  component: 'witness-clickhouse-keeper',
  version: '25.8.28.1',
  arch: 'arm64',
  artifactName,
  downloadUrl,
  sha256: SHA,
  createdAt: '2026-10-11T00:00:00Z',
};

function catalog(body: string, status = 200, version = 'v2.12.0') {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
  return {
    fetcher,
    catalog: new WitnessCatalog({ ARTIFACT_BASE_URL: BASE, APP_VERSION: version }, fetcher, publicPem),
  };
}

describe('witness catalog', () => {
  it('lists the same witnesses as the release pipeline', () => {
    const config = JSON.parse(
      readFileSync(new URL('../../../../../config/witness-artifacts.json', import.meta.url), 'utf8')
    ) as { witnesses: { kind: string; component: string; version: string; arches: string[] }[] };
    expect(
      config.witnesses.map(({ kind, component, version, arches }) => ({ kind, component, version, arches }))
    ).toEqual(WITNESS_ARTIFACTS);
    expect(currentWitnessVersion('clickhouse_keeper')).toBe('25.8.28.1');
  });

  it('resolves a signed artifact of this release and caches it', async () => {
    const signed = manifest(good);
    const { fetcher, catalog: subject } = catalog(signed);
    const artifact = await subject.resolve('clickhouse_keeper', '25.8.28.1', 'aarch64');
    expect(artifact).toEqual({
      version: '25.8.28.1',
      downloadUrl,
      sha256: SHA,
      signedManifest: signed,
      component: 'witness-clickhouse-keeper',
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${downloadUrl}.update.json`);
    await subject.resolve('clickhouse_keeper', '25.8.28.1', 'arm64');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a daemon manifest', manifest({ ...good, kind: 'daemon-binary' })],
    ['another architecture', manifest({ ...good, arch: 'amd64' })],
    ['another download URL', manifest({ ...good, downloadUrl: 'https://elsewhere.example/keeper' })],
    ['another signing key', manifest(good, generateKeyPairSync('ed25519').privateKey)],
  ])('refuses %s', async (_name, body) => {
    await expect(catalog(body).catalog.resolve('clickhouse_keeper', '25.8.28.1', 'arm64')).rejects.toThrow();
  });

  it('has nothing for development builds, unknown versions or missing assets', async () => {
    expect(
      await catalog(manifest(good), 200, 'dev').catalog.resolve('clickhouse_keeper', '25.8.28.1', 'arm64')
    ).toBeNull();
    expect(await catalog(manifest(good)).catalog.resolve('clickhouse_keeper', '24.1.1.1', 'arm64')).toBeNull();
    expect(await catalog('', 404).catalog.resolve('clickhouse_keeper', '25.8.28.1', 'arm64')).toBeNull();
  });
});
