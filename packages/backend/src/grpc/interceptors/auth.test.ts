import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureRelayForwardedIdentityTrust,
  extractDaemonCertificateIdentity,
  extractNodeIdFromCert,
  normalizeCertificateSerial,
  stageRelayForwardedIdentityTrust,
} from './auth.js';

function makeCall(options: {
  cn?: string | null;
  serialNumber?: string | null;
  authorized?: boolean;
  includeAuthorized?: boolean;
  useAuthContext?: boolean;
}) {
  const peerCertificate =
    options.cn || options.serialNumber
      ? {
          subject: options.cn ? { CN: options.cn } : {},
          serialNumber: options.serialNumber ?? undefined,
        }
      : {};
  const socket: Record<string, unknown> = {
    authorizationError: options.authorized === false ? 'SELF_SIGNED_CERT_IN_CHAIN' : null,
    getPeerCertificate: () => peerCertificate,
  };
  if (options.includeAuthorized !== false) {
    socket.authorized = options.authorized ?? true;
  }

  return {
    ...(options.useAuthContext ? { getAuthContext: () => ({ sslPeerCertificate: peerCertificate }) } : {}),
    handler: {
      http2Stream: {
        session: {
          socket,
        },
      },
    },
  } as any;
}

describe('extractDaemonCertificateIdentity', () => {
  const nodeId = '11111111-1111-4111-8111-111111111111';

  it('returns node id and normalized serial from a definitely authorized client certificate', () => {
    expect(
      extractDaemonCertificateIdentity(makeCall({ cn: nodeId, serialNumber: 'AA:bb:01', authorized: true }))
    ).toEqual({ nodeId, serialNumber: 'aabb01' });
  });

  it('rejects unauthorized certificates even when CN and serial are present', () => {
    expect(extractDaemonCertificateIdentity(makeCall({ cn: nodeId, serialNumber: 'aa01', authorized: false }))).toBe(
      null
    );
  });

  it('rejects ambiguous authorization state even when auth context exposes a certificate', () => {
    expect(
      extractDaemonCertificateIdentity(
        makeCall({ cn: nodeId, serialNumber: 'aa01', includeAuthorized: false, useAuthContext: true })
      )
    ).toBe(null);
  });

  it('rejects certificates without a usable serial number', () => {
    expect(extractDaemonCertificateIdentity(makeCall({ cn: nodeId, serialNumber: null, authorized: true }))).toBe(null);
  });

  it('rejects missing or invalid certificate CNs', () => {
    expect(extractDaemonCertificateIdentity(makeCall({ cn: null, serialNumber: 'aa01', authorized: true }))).toBe(null);
    expect(
      extractDaemonCertificateIdentity(makeCall({ cn: 'not-a-node-id', serialNumber: 'aa01', authorized: true }))
    ).toBe(null);
  });
});

describe('relay-forwarded daemon identity', () => {
  const nodeId = '11111111-1111-4111-8111-111111111111';
  const raw = Buffer.from('current-relay-certificate');
  const fingerprint = `sha256:${createHash('sha256').update(raw).digest('hex')}`;

  afterEach(() => configureRelayForwardedIdentityTrust(null));

  function forwardedCall(peerRaw = raw, entries?: Record<string, string>) {
    const metadata = new grpc.Metadata();
    for (const [key, value] of Object.entries(
      entries ?? {
        'x-opfield-relay-node-id': nodeId,
        'x-opfield-relay-cert-serial': 'AA:01',
        'x-opfield-relay-cert-sha256': `sha256:${'ab'.repeat(32)}`,
      }
    )) {
      metadata.set(key, value);
    }
    return {
      metadata,
      handler: {
        http2Stream: {
          session: {
            socket: {
              authorized: true,
              getPeerCertificate: () => ({ raw: peerRaw, subject: { CN: 'relay-app-client' }, serialNumber: '02' }),
            },
          },
        },
      },
    } as any;
  }

  it('accepts forwarded identity only from the configured relay service leaf', () => {
    configureRelayForwardedIdentityTrust(fingerprint);
    expect(extractDaemonCertificateIdentity(forwardedCall())).toEqual({
      nodeId,
      serialNumber: 'aa01',
      certificateFingerprint: `sha256:${'ab'.repeat(32)}`,
    });
  });

  it('reads the legacy headers of a relay before 2.12.1 and ignores new ones it passed through', () => {
    configureRelayForwardedIdentityTrust(fingerprint);
    const forged = '22222222-2222-4222-8222-222222222222';
    expect(
      extractDaemonCertificateIdentity(
        forwardedCall(raw, {
          'x-wiolett-relay-node-id': nodeId,
          'x-wiolett-relay-cert-serial': 'AA:01',
          'x-wiolett-relay-cert-sha256': `sha256:${'ab'.repeat(32)}`,
          'x-opfield-relay-node-id': forged,
          'x-opfield-relay-cert-serial': 'FF',
          'x-opfield-relay-cert-sha256': `sha256:${'cd'.repeat(32)}`,
        })
      )
    ).toEqual({ nodeId, serialNumber: 'aa01', certificateFingerprint: `sha256:${'ab'.repeat(32)}` });
  });

  it('does not mix legacy and new keys: a partial legacy set is rejected', () => {
    configureRelayForwardedIdentityTrust(fingerprint);
    expect(
      extractDaemonCertificateIdentity(
        forwardedCall(raw, {
          'x-wiolett-relay-node-id': nodeId,
          'x-opfield-relay-cert-serial': 'AA:01',
          'x-opfield-relay-cert-sha256': `sha256:${'ab'.repeat(32)}`,
        })
      )
    ).toBeNull();
  });

  it('rejects spoofed forwarded metadata from another system-CA client', () => {
    configureRelayForwardedIdentityTrust(fingerprint);
    expect(extractDaemonCertificateIdentity(forwardedCall(Buffer.from('daemon-certificate')))).toBeNull();
  });

  it('accepts old and new relay leaves until the rotation is committed', () => {
    const nextRaw = Buffer.from('next-relay-certificate');
    const nextFingerprint = `sha256:${createHash('sha256').update(nextRaw).digest('hex')}`;
    configureRelayForwardedIdentityTrust(fingerprint);

    const commit = stageRelayForwardedIdentityTrust(nextFingerprint);
    expect(extractDaemonCertificateIdentity(forwardedCall(raw))).not.toBeNull();
    expect(extractDaemonCertificateIdentity(forwardedCall(nextRaw))).not.toBeNull();

    commit();
    expect(extractDaemonCertificateIdentity(forwardedCall(raw))).toBeNull();
    expect(extractDaemonCertificateIdentity(forwardedCall(nextRaw))).not.toBeNull();
  });

  it('keeps trusting the rotated relay leaf when the reload is never acknowledged', () => {
    vi.useFakeTimers();
    try {
      const nextRaw = Buffer.from('unacknowledged-relay-certificate');
      const nextFingerprint = `sha256:${createHash('sha256').update(nextRaw).digest('hex')}`;
      configureRelayForwardedIdentityTrust(fingerprint);

      stageRelayForwardedIdentityTrust(nextFingerprint);

      // The relay has the new files on disk; a later restart presents them.
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(extractDaemonCertificateIdentity(forwardedCall(raw))).not.toBeNull();
      expect(extractDaemonCertificateIdentity(forwardedCall(nextRaw))).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits the rotated relay leaf once the relay presents it', () => {
    const nextRaw = Buffer.from('reloaded-relay-certificate');
    const nextFingerprint = `sha256:${createHash('sha256').update(nextRaw).digest('hex')}`;
    configureRelayForwardedIdentityTrust(fingerprint);

    stageRelayForwardedIdentityTrust(nextFingerprint);
    expect(extractDaemonCertificateIdentity(forwardedCall(raw))).not.toBeNull();
    expect(extractDaemonCertificateIdentity(forwardedCall(nextRaw))).not.toBeNull();

    expect(extractDaemonCertificateIdentity(forwardedCall(raw))).toBeNull();
    expect(extractDaemonCertificateIdentity(forwardedCall(nextRaw))).not.toBeNull();
  });
});

describe('normalizeCertificateSerial', () => {
  it('normalizes case and colon separators', () => {
    expect(normalizeCertificateSerial('AA:bb:01')).toBe('aabb01');
  });

  it('trims whitespace', () => {
    expect(normalizeCertificateSerial('  aa01  ')).toBe('aa01');
  });

  it('treats certificate serials as integers when TLS omits leading zeroes', () => {
    expect(normalizeCertificateSerial('04:EC:C1')).toBe('4ecc1');
    expect(normalizeCertificateSerial('0000')).toBe('0');
  });
});

describe('extractNodeIdFromCert', () => {
  it('returns the node id from an authorized client certificate CN', () => {
    const nodeId = '11111111-1111-4111-8111-111111111111';

    expect(extractNodeIdFromCert(makeCall({ cn: nodeId, serialNumber: 'aa01' }))).toBe(nodeId);
  });

  it('supports grpc-js bidi stream call nesting and auth context', () => {
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const peerCertificate = { subject: { CN: nodeId }, serialNumber: 'aa01' };
    const call = {
      getAuthContext: () => ({ transportSecurityType: 'ssl', sslPeerCertificate: peerCertificate }),
      call: {
        nextCall: {
          stream: {
            session: {
              socket: {
                authorized: true,
                getPeerCertificate: () => peerCertificate,
              },
            },
          },
        },
      },
    } as any;

    expect(extractNodeIdFromCert(call)).toBe(nodeId);
  });

  it('rejects unauthorized client certificates even when a CN is present', () => {
    expect(
      extractNodeIdFromCert(
        makeCall({ cn: '11111111-1111-4111-8111-111111111111', serialNumber: 'aa01', authorized: false })
      )
    ).toBe(null);
  });

  it('rejects missing or invalid certificate CNs', () => {
    expect(extractNodeIdFromCert(makeCall({ cn: null, serialNumber: 'aa01' }))).toBe(null);
    expect(extractNodeIdFromCert(makeCall({ cn: 'not-a-node-id', serialNumber: 'aa01' }))).toBe(null);
  });
});

describe('extractNodeIdFromCert compatibility wrapper', () => {
  it('returns only the node id for callers that still use the old helper', () => {
    const nodeId = '11111111-1111-4111-8111-111111111111';

    expect(extractNodeIdFromCert(makeCall({ cn: nodeId, serialNumber: 'aa01', authorized: true }))).toBe(nodeId);
  });
});
