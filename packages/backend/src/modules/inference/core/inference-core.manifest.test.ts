import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_CORE_RELEASE_LINE, LEGACY_MIN_VERSION_FIELD } from '@/lib/legacy-compat.js';
import { UPDATE_SIGNING_KEY_ID } from '@/lib/update-artifact-trust.js';
import { INFERENCE_CORE_PROTOCOL_MAJOR } from './inference-core.contract.js';
import {
  checkOpenCodexOpfieldCompatibility,
  compareOpenCodexVersions,
  fetchLatestOpenCodexTag,
  fetchOpenCodexImageManifest,
  OPENCODEX_RELEASE_TAG_RE,
  OPENCODEX_VERSION_RE,
  parseOpenCodexVersion,
} from './inference-core.manifest.js';

describe('core release lines', () => {
  it('accepts the earliest, thesqlabs and opfield lines', () => {
    for (const tag of [`v2.25.0-${LEGACY_CORE_RELEASE_LINE}.27`, 'v2.60.6-thesqlabs.6', 'v2.61.0-opfield.1']) {
      expect(OPENCODEX_RELEASE_TAG_RE.test(tag)).toBe(true);
      expect(OPENCODEX_VERSION_RE.test(tag.slice(1))).toBe(true);
      expect(parseOpenCodexVersion(tag)).not.toBeNull();
    }
    expect(OPENCODEX_RELEASE_TAG_RE.test('v2.61.0-other.1')).toBe(false);
    expect(OPENCODEX_RELEASE_TAG_RE.test('v2.61.0-opfield')).toBe(false);
  });

  it('orders across the switch to the opfield line', () => {
    expect(compareOpenCodexVersions('2.61.0-opfield.1', '2.60.6-thesqlabs.6')).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('v2.60.6-thesqlabs.6', 'v2.61.0-opfield.1')).toBeLessThan(0);
    // On the same base a later line wins whatever the build numbers.
    expect(compareOpenCodexVersions('2.60.0-opfield.1', '2.60.0-thesqlabs.9')).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('2.60.0-thesqlabs.1', `2.60.0-${LEGACY_CORE_RELEASE_LINE}.40`)).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('2.60.0-opfield.2', '2.60.0-opfield.10')).toBeLessThan(0);
    expect(compareOpenCodexVersions('2.61.0-opfield.3', 'v2.61.0-opfield.3')).toBe(0);
  });
});

describe('core release feed and manifest names', () => {
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
  const sha = 'b'.repeat(64);
  const image = 'ghcr.io/opfield/opfield-inference';
  const tag = 'v2.62.0-opfield.1';

  function signed(payload: Record<string, unknown>): string {
    const bytes = Buffer.from(JSON.stringify(payload));
    return JSON.stringify({
      schemaVersion: 1,
      keyId: UPDATE_SIGNING_KEY_ID,
      payload: bytes.toString('base64url'),
      signature: sign(null, bytes, key.privateKey).toString('base64url'),
    });
  }

  function coreManifest(fields: Record<string, unknown>): string {
    return signed({
      kind: 'opfield-inference-image',
      version: tag.slice(1),
      tag,
      image,
      digest: `sha256:${sha}`,
      imageRef: `${image}@sha256:${sha}`,
      sizeBytes: 1000,
      coreProtocolMajor: INFERENCE_CORE_PROTOCOL_MAJOR,
      stateSchemaVersion: 1,
      buildRevision: 'abc123',
      createdAt: '2026-10-13T00:00:00Z',
      ...fields,
    });
  }

  function mockFetch(routes: Record<string, () => Response>) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        calls.push(url);
        const route = routes[url];
        return route ? route() : new Response('not found', { status: 404 });
      })
    );
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the feed for opfield-inference and falls back to inference-core while the feed does not know it', async () => {
    const calls = mockFetch({
      'https://feed.example/releases?component=opfield-inference': () =>
        Response.json({ error: 'invalid_component' }, { status: 400 }),
      'https://feed.example/releases?component=inference-core': () =>
        Response.json({ target: { tag_name: 'v2.61.0-opfield.4' } }),
    });

    await expect(fetchLatestOpenCodexTag('https://feed.example/releases')).resolves.toBe('v2.61.0-opfield.4');
    expect(calls).toEqual([
      'https://feed.example/releases?component=opfield-inference',
      'https://feed.example/releases?component=inference-core',
    ]);
  });

  it('takes the newer tag when both feed components answer', async () => {
    mockFetch({
      'https://feed.example/releases?component=opfield-inference': () =>
        Response.json({ target: { tag_name: 'v2.62.0-opfield.1' } }),
      'https://feed.example/releases?component=inference-core': () =>
        Response.json({ target: { tag_name: 'v2.61.0-opfield.4' } }),
    });

    await expect(fetchLatestOpenCodexTag('https://feed.example/releases')).resolves.toBe('v2.62.0-opfield.1');
  });

  it('reads the opfield-inference manifest first and honours minOpfieldVersion', async () => {
    const calls = mockFetch({
      [`https://get.example/opfield-inference/${tag}/opfield-inference-image.update.json`]: () =>
        new Response(coreManifest({ minOpfieldVersion: 'v2.12.1', [LEGACY_MIN_VERSION_FIELD]: 'v2.12.1' })),
    });

    const artifact = await fetchOpenCodexImageManifest('https://get.example', tag, [image], publicKey);

    expect(calls).toEqual([`https://get.example/opfield-inference/${tag}/opfield-inference-image.update.json`]);
    expect(artifact.minOpfieldVersion).toBe('v2.12.1');
    expect(checkOpenCodexOpfieldCompatibility(artifact, '2.12.0').compatible).toBe(false);
    expect(checkOpenCodexOpfieldCompatibility(artifact, '2.12.1').compatible).toBe(true);
  });

  it('falls back to the legacy opencodex-image manifest of releases published before the rename', async () => {
    const legacyImage = 'ghcr.io/opfield/inference-core';
    const calls = mockFetch({
      [`https://get.example/inference-core/${tag}/opencodex-image.update.json`]: () =>
        new Response(
          coreManifest({
            kind: 'opencodex-image',
            image: legacyImage,
            imageRef: `${legacyImage}@sha256:${sha}`,
            [LEGACY_MIN_VERSION_FIELD]: 'v2.13.0',
          })
        ),
    });

    const artifact = await fetchOpenCodexImageManifest('https://get.example', tag, [image, legacyImage], publicKey);

    expect(calls).toEqual([
      `https://get.example/opfield-inference/${tag}/opfield-inference-image.update.json`,
      `https://get.example/inference-core/${tag}/opencodex-image.update.json`,
    ]);
    expect(artifact.imageRef).toBe(`${legacyImage}@sha256:${sha}`);
    expect(artifact.minOpfieldVersion).toBe('v2.13.0');
    expect(checkOpenCodexOpfieldCompatibility(artifact, '2.12.1')).toEqual({
      compatible: false,
      reason: 'Core 2.62.0-opfield.1 requires Opfield v2.13.0 or newer',
    });
  });

  it('reports an unavailable release when neither manifest exists', async () => {
    mockFetch({});

    await expect(fetchOpenCodexImageManifest('https://get.example', tag, [image], publicKey)).rejects.toMatchObject({
      code: 'CORE_RELEASE_UNAVAILABLE',
    });
  });
});
