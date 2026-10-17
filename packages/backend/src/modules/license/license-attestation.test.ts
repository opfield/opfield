import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalLicenseFeature,
  isCanonicalEntitlements,
  LICENSE_PLAN_ENTITLEMENTS,
  type LicenseServerState,
} from './license.types.js';
import {
  LICENSE_ATTESTATION_MAX_CLOCK_SKEW_MS,
  LICENSE_SIGNING_PUBLIC_KEYS,
  LicenseAttestationVerifier,
} from './license-attestation.js';
import {
  createTestLicenseSigner,
  createTestLicenseVerifier,
  signTestLicenseState,
  TEST_INSTALLATION_ID,
} from './license-attestation.test-helpers.js';
import { LEGACY_INFERENCE_FEATURE, LEGACY_LICENSE_STATE_DOMAIN_SHORT } from '@/lib/legacy-compat.js';

/** Produced by the license server's Go signer (internal/attestation) from a fixed seed. */
const GO_SIGNED = {
  publicKey: 'MCowBQYDK2VwAyEAebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=',
  attestation: {
    schemaVersion: 1,
    keyId: 'gls-golden',
    algorithm: 'Ed25519',
    payload:
      'eyJraW5kIjoiZ2F0ZXdheS1saWNlbnNlLXN0YXRlIiwiaW5zdGFsbGF0aW9uSWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJwdXJwb3NlIjoiaGVhcnRiZWF0IiwicmVxdWVzdE5vbmNlIjoiZ29sZGVuLXJlcXVlc3Qtbm9uY2UtMDAwMSIsImlzc3VlZEF0IjoiMjAyNi0wOS0yNVQxMjowMDowMFoiLCJzdGF0ZSI6eyJyZWdpc3RyYXRpb25TdGF0dXMiOiJyZWdpc3RlcmVkIiwiZWZmZWN0aXZlUGxhbiI6ImNvbW11bml0eSIsInBhaWRMaWNlbnNlU3RhdHVzIjoibm9uZSIsImdyYWNlVW50aWwiOm51bGwsImVudGl0bGVtZW50cyI6eyJtYW5hZ2VkTm9kZXMiOjI1LCJ1c2VycyI6MywiY3VzdG9tUGVybWlzc2lvbkdyb3VwcyI6MSwic3VwcG9ydExldmVsIjoiY29tbXVuaXR5IiwiZmVhdHVyZXMiOlsiaW5mcmFzdHJ1Y3R1cmUiLCJuZ2lueCIsImRvY2tlciIsInRscyIsImRvbWFpbnMiLCJtb25pdG9yaW5nIiwiYXV0aCIsInJiYWMiLCJhdWRpdCIsImFwaSIsIm9hdXRoIiwibWNwIiwiYWktd29ya3NwYWNlIiwiZ2F0ZXdheS1pbmZlcmVuY2UiLCJzaWduZWQtdXBkYXRlcyJdfSwiZW50aXRsZW1lbnRzVmVyc2lvbiI6NSwic2VydmVyVGltZSI6IjIwMjYtMDktMjVUMTI6MDA6MDBaIn19',
    signature: 'hQnCsX-aLwEfnKjphslcgzQw8BazXGEfWttMyTaDiQntukui5ztTGbd9wro-fP3qXoRPjlY34IPtDsw4hKnnAQ',
  },
};
const GO_ISSUED_AT = Date.parse('2026-09-25T12:00:00Z');

const state = (): LicenseServerState => ({
  registrationStatus: 'registered',
  effectivePlan: 'community',
  paidLicenseStatus: 'none',
  graceUntil: null,
  entitlementsVersion: 5,
  entitlements: LICENSE_PLAN_ENTITLEMENTS.community,
  serverTime: new Date().toISOString(),
});

describe('LicenseAttestationVerifier', () => {
  it('verifies a state signed by the license server implementation', () => {
    const verifier = new LicenseAttestationVerifier({ 'gls-golden': GO_SIGNED.publicKey });
    const payload = verifier.verifyResponse(
      GO_SIGNED.attestation,
      TEST_INSTALLATION_ID,
      { purpose: 'heartbeat', requestNonce: 'golden-request-nonce-0001' },
      GO_ISSUED_AT
    );

    expect(payload).toMatchObject({
      kind: LEGACY_LICENSE_STATE_DOMAIN_SHORT,
      installationId: TEST_INSTALLATION_ID,
      issuedAt: '2026-09-25T12:00:00Z',
      state: { effectivePlan: 'community', paidLicenseStatus: 'none', entitlementsVersion: 5 },
    });
    // The license server signs the inference feature under its pre-2.12.1 key; Opfield accepts both.
    expect(payload.state.entitlements.features).toContain(LEGACY_INFERENCE_FEATURE);
    expect({
      ...payload.state.entitlements,
      features: payload.state.entitlements.features.map(canonicalLicenseFeature),
    }).toEqual(LICENSE_PLAN_ENTITLEMENTS.community);
    expect(isCanonicalEntitlements('community', payload.state.entitlements)).toBe(true);
  });

  it('pins an Ed25519 production key for every key ID', () => {
    const verifier = new LicenseAttestationVerifier();
    expect(verifier.keyIds).toEqual(Object.keys(LICENSE_SIGNING_PUBLIC_KEYS));
    expect(verifier.keyIds.length).toBeGreaterThan(0);
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(() => new LicenseAttestationVerifier({ bad: publicKey })).toThrow('is not Ed25519');
  });

  it.each([
    ['an unsigned state', () => undefined],
    ['an unknown key', () => ({ ...GO_SIGNED.attestation, keyId: 'gls-unknown' })],
    ['an unsupported format', () => ({ ...GO_SIGNED.attestation, schemaVersion: 2 })],
    [
      'a tampered signature',
      () => ({ ...GO_SIGNED.attestation, signature: `A${GO_SIGNED.attestation.signature.slice(1)}` }),
    ],
    [
      'a tampered payload',
      () => ({
        ...GO_SIGNED.attestation,
        payload: Buffer.from(
          Buffer.from(GO_SIGNED.attestation.payload, 'base64url').toString().replace('community', 'enterprise')
        ).toString('base64url'),
      }),
    ],
  ])('rejects %s', (_label, value) => {
    const verifier = new LicenseAttestationVerifier({ 'gls-golden': GO_SIGNED.publicKey });
    expect(() =>
      verifier.verifyResponse(
        value(),
        TEST_INSTALLATION_ID,
        { purpose: 'heartbeat', requestNonce: 'golden-request-nonce-0001' },
        GO_ISSUED_AT
      )
    ).toThrow();
  });

  it('binds a fresh response to the installation, purpose, nonce, and issue time', () => {
    const verifier = new LicenseAttestationVerifier({ 'gls-golden': GO_SIGNED.publicKey });
    const binding = { purpose: 'heartbeat' as const, requestNonce: 'golden-request-nonce-0001' };
    const attempt = (installationId: string, next: typeof binding, now: number) => () =>
      verifier.verifyResponse(GO_SIGNED.attestation, installationId, next, now);

    expect(attempt('22222222-2222-4222-8222-222222222222', binding, GO_ISSUED_AT)).toThrow('another installation');
    expect(attempt(TEST_INSTALLATION_ID, { ...binding, purpose: 'activate' as never }, GO_ISSUED_AT)).toThrow(
      'another request'
    );
    expect(attempt(TEST_INSTALLATION_ID, { ...binding, requestNonce: 'replayed-nonce' }, GO_ISSUED_AT)).toThrow(
      'another request'
    );
    expect(attempt(TEST_INSTALLATION_ID, binding, GO_ISSUED_AT + LICENSE_ATTESTATION_MAX_CLOCK_SKEW_MS + 1)).toThrow(
      'stale'
    );
    expect(attempt(TEST_INSTALLATION_ID, binding, GO_ISSUED_AT - LICENSE_ATTESTATION_MAX_CLOCK_SKEW_MS - 1)).toThrow(
      'stale'
    );
    expect(attempt(TEST_INSTALLATION_ID, binding, GO_ISSUED_AT + LICENSE_ATTESTATION_MAX_CLOCK_SKEW_MS)).not.toThrow();
    // A stored state is re-checked for its signature and installation only.
    expect(verifier.verifyStored(GO_SIGNED.attestation, TEST_INSTALLATION_ID).issuedAt).toBe('2026-09-25T12:00:00Z');
    expect(() => verifier.verifyStored(GO_SIGNED.attestation, '22222222-2222-4222-8222-222222222222')).toThrow();
  });

  it('accepts every pinned key during a rotation and nothing else', () => {
    const current = createTestLicenseSigner('gls-current');
    const next = createTestLicenseSigner('gls-next');
    const retired = createTestLicenseSigner('gls-retired');
    const verifier = createTestLicenseVerifier(current, next);
    const binding = { purpose: 'heartbeat' as const, requestNonce: 'rotation-request-nonce' };

    for (const signer of [current, next]) {
      const attestation = signTestLicenseState(signer, state(), binding);
      expect(verifier.verifyResponse(attestation, TEST_INSTALLATION_ID, binding).state.effectivePlan).toBe('community');
    }
    expect(() =>
      verifier.verifyResponse(signTestLicenseState(retired, state(), binding), TEST_INSTALLATION_ID, binding)
    ).toThrow('unknown key');
    // A retired key ID reused with another key is still rejected.
    const impostor = createTestLicenseSigner('gls-current');
    expect(() =>
      verifier.verifyResponse(signTestLicenseState(impostor, state(), binding), TEST_INSTALLATION_ID, binding)
    ).toThrow('signature is invalid');
  });
});
