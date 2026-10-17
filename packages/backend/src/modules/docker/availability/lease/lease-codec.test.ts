import { createHash, createPrivateKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeRelayV1Message } from '@/grpc/relay-proto.js';
import {
  compareLeaseBallots,
  decodeLeaseSignedBlock,
  encodeLeaseManifest,
  encodeLeaseSignedBlock,
  type LeaseManifestContent,
  leaseBlockMessage,
  leaseKeyRotationMessage,
  leaseManifestClosure,
  leaseManifestDigest,
  leaseManifestSupportsStateful,
  policyKeyFingerprint,
  signLeaseBlock,
} from './lease-codec.js';
import { LEGACY_AVAILABILITY_LEASE_DOMAIN } from '@/lib/legacy-compat.js';

/** The Ed25519 key daemon-shared/availabilitylease derives from the same seed (cross-checked with its Go code). */
function goldenKey(label: string) {
  const seed = createHash('sha256').update(label).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const { x } = privateKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKey: Buffer.from(x, 'base64url') };
}

const k1 = goldenKey('lease-golden-k1');
const k2 = goldenKey('lease-golden-k2');
const signer = async (message: Buffer, keyId: string) => ({
  signingKeyId: keyId,
  signature: sign(null, message, (keyId === 'k1' ? k1 : k2).privateKey),
});

const manifest: LeaseManifestContent = {
  policyId: 'policy-1',
  mode: 'failover',
  partitionMode: 'strict',
  slots: 1,
  candidates: [
    { id: 'node-1', publicKey: Buffer.from('key-1') },
    { id: 'node-2', publicKey: Buffer.from('key-2') },
  ],
  specFingerprint: 'spec',
  voterEpoch: 4,
  closed: false,
  bootstrapId: 77,
  bootstrap: [{ slot: 0, holderId: 'node-1' }],
  members: [
    { id: 'node-1', role: 'daemon', publicKey: Buffer.from('key-1') },
    { id: 'node-2', role: 'daemon', publicKey: Buffer.from('key-2') },
    { id: 'relay-1', role: 'relay', publicKey: Buffer.from('r') },
  ],
  quorumSets: [['node-1', 'node-2', 'relay-1']],
};

describe('availability lease codec', () => {
  // Signatures produced by availabilitylease.SignPolicyBlock / SignPolicyKeyRotation (Go) for the same keys. Ed25519
  // is deterministic, so equal signatures prove the signed byte strings are identical in both languages.
  it('signs blocks and rotation links byte-for-byte like daemon-shared/availabilitylease', async () => {
    expect(k1.publicKey.toString('hex')).toBe('5482fda156e3fc9675563e974a1b6e661bc98841b29cc31edfe8f62fe6559d61');
    const block = await signLeaseBlock('LEASE_BLOCK_KIND_MANIFEST', Buffer.from('fixed-payload'), 'k1', signer);
    expect(block.signature.toString('hex')).toBe(
      'f1b09292eb2b8ca2bfc8f36ce61fc7534704f9fd92f8ac8e46d96de98647552fd3724fbe796cb4489842a74a63eb94ae45bb71857919d790212d5cf2f80bf205'
    );
    const rotation = await signer(leaseKeyRotationMessage('k2', k2.publicKey), 'k1');
    expect(rotation.signature.toString('hex')).toBe(
      'bde0c19e14d039777783417017f92f1b6b551e7b89546b154826de282d08887a25ba96d65c4c5610a149ed973bca592fae3ae408a20dfd06502ccb182857fa03'
    );
  });

  it('prefixes every signed statement with its domain and a zero byte', () => {
    expect(leaseBlockMessage('LEASE_BLOCK_KIND_MANIFEST', Buffer.from('p')).toString()).toBe(
      `${LEGACY_AVAILABILITY_LEASE_DOMAIN}/manifest/v1\u0000p`
    );
    const rotation = leaseKeyRotationMessage('ab', Buffer.from([9]));
    expect(rotation.subarray(0, 43).toString()).toBe(`${LEGACY_AVAILABILITY_LEASE_DOMAIN}/key-rotation/v1\u0000`);
    expect([...rotation.subarray(43)]).toEqual([0, 0, 0, 2, 0x61, 0x62, 9]);
    expect(policyKeyFingerprint(Buffer.from('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('encodes manifests with their per-policy voters as relay.v1 messages (A18)', async () => {
    const decoded = decodeRelayV1Message('LeaseManifest', encodeLeaseManifest(manifest, 9)) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      schemaVersion: 1,
      policyId: 'policy-1',
      manifestVersion: '9',
      mode: 'LEASE_POLICY_MODE_FAILOVER',
      partitionMode: 'LEASE_PARTITION_MODE_STRICT',
      slots: 1,
      voterEpoch: '4',
      bootstrapId: '77',
      bootstrap: [{ slot: 0, holderId: 'node-1' }],
      leaseTermMs: 30000,
      members: [
        { id: 'node-1', role: 'LEASE_MEMBER_ROLE_DAEMON' },
        { id: 'node-2', role: 'LEASE_MEMBER_ROLE_DAEMON' },
        { id: 'relay-1', role: 'LEASE_MEMBER_ROLE_RELAY' },
      ],
      quorumSets: [{ voterIds: ['node-1', 'node-2', 'relay-1'] }],
    });
    const block = await signLeaseBlock('LEASE_BLOCK_KIND_MANIFEST', Buffer.from('payload'), 'k2', signer);
    expect(decodeLeaseSignedBlock(encodeLeaseSignedBlock(block))).toEqual(block);
  });

  it('versions a manifest only when its content changes', () => {
    const digest = leaseManifestDigest(manifest);
    expect(leaseManifestDigest({ ...manifest })).toBe(digest);
    expect(leaseManifestDigest({ ...manifest, closed: true })).not.toBe(digest);
    expect(leaseManifestDigest({ ...manifest, voterEpoch: 5 })).not.toBe(digest);
    expect(
      leaseManifestDigest({
        ...manifest,
        quorumSets: [
          ['node-1', 'node-2'],
          ['node-1', 'relay-1'],
        ],
      })
    ).not.toBe(digest);
    expect(leaseManifestDigest({ ...manifest, candidates: [...manifest.candidates].reverse() })).not.toBe(digest);
  });

  it('digests a stateless manifest exactly as before v3 and a stateful one differently (AS8)', () => {
    const digest = leaseManifestDigest(manifest);
    expect(leaseManifestDigest({ ...manifest, stateful: false })).toBe(digest);
    expect(leaseManifestDigest({ ...manifest, stateful: true })).not.toBe(digest);
    // The pre-v3 digest input: the content without the flag, keys in publishing order.
    const { stateful: _stateful, ...rest } = manifest;
    expect(digest).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            ...rest,
            candidates: manifest.candidates.map((candidate) => [candidate.id, candidate.publicKey.toString('base64')]),
            members: manifest.members.map((member) => [member.id, member.role, member.publicKey.toString('base64')]),
          })
        )
        .digest('hex')
    );
  });

  it('never encodes a stateful manifest as a stateless one', () => {
    const stateful = { ...manifest, stateful: true };
    if (!leaseManifestSupportsStateful()) {
      expect(() => encodeLeaseManifest(stateful, 1)).toThrow(/stateful/);
      return;
    }
    const decoded = decodeRelayV1Message('LeaseManifest', encodeLeaseManifest(stateful, 1)) as { stateful: boolean };
    expect(decoded.stateful).toBe(true);
    expect(encodeLeaseManifest(manifest, 1)).toEqual(encodeLeaseManifest({ ...manifest, stateful: false }, 1));
  });

  it('orders ballots by round, incarnation and proposer', () => {
    const ballot = (round: string, incarnation: string, proposerId: string) => ({ round, incarnation, proposerId });
    expect(compareLeaseBallots(ballot('2', '1', 'a'), ballot('10', '0', 'a'))).toBe(-1);
    expect(compareLeaseBallots(ballot('10', '2', 'a'), ballot('10', '1', 'z'))).toBe(1);
    expect(compareLeaseBallots(ballot('10', '2', 'a'), ballot('10', '2', 'b'))).toBe(-1);
    expect(compareLeaseBallots(ballot('18446744073709551615', '0', 'a'), ballot('1', '0', 'a'))).toBe(1);
    expect(compareLeaseBallots(null, ballot('1', '0', 'a'))).toBe(-1);
    expect(compareLeaseBallots(ballot('1', '0', 'a'), ballot('1', '0', 'a'))).toBe(0);
  });

  it('names the retained holders in a closed manifest only, and leaves other manifests unchanged (graceful close)', async () => {
    const ballot = { round: '12', incarnation: '3', proposerId: 'node-1' };
    const closed: LeaseManifestContent = {
      ...manifest,
      closed: true,
      retained: [{ slot: 0, holderId: 'node-1', ballot }],
    };
    const decoded = decodeRelayV1Message('LeaseManifest', encodeLeaseManifest(closed, 9)) as {
      closed: boolean;
      retained: Array<{ slot: number; holderId: string; ballot: typeof ballot }>;
    };
    expect(decoded.closed).toBe(true);
    expect(decoded.retained).toEqual([{ slot: 0, holderId: 'node-1', ballot }]);
    const block = encodeLeaseSignedBlock(
      await signLeaseBlock('LEASE_BLOCK_KIND_MANIFEST', encodeLeaseManifest(closed, 9), 'k1', signer)
    ).toString('base64');
    expect(leaseManifestClosure(block)).toEqual({ closed: true, retained: [{ slot: 0, holderId: 'node-1', ballot }] });
    expect(leaseManifestDigest(closed)).not.toBe(leaseManifestDigest({ ...closed, retained: [] }));
    // An open manifest never carries retained holders, and its digest is what it was before the field existed.
    expect(encodeLeaseManifest({ ...manifest, retained: closed.retained }, 9)).toEqual(
      encodeLeaseManifest(manifest, 9)
    );
    expect(leaseManifestDigest(manifest)).toBe(leaseManifestDigest({ ...manifest, retained: undefined }));
    expect(leaseManifestClosure(null)).toBeNull();
    // A reserved bootstrap holder Opfield saw no commit of is named with an empty ballot.
    const reserved = { ...closed, retained: [{ slot: 0, holderId: 'node-2', ballot: null }] };
    const reservedBlock = encodeLeaseSignedBlock(
      await signLeaseBlock('LEASE_BLOCK_KIND_MANIFEST', encodeLeaseManifest(reserved, 10), 'k1', signer)
    ).toString('base64');
    expect(leaseManifestClosure(reservedBlock)).toEqual({
      closed: true,
      retained: [{ slot: 0, holderId: 'node-2', ballot: null }],
    });
    expect(
      (
        decodeRelayV1Message('LeaseManifest', encodeLeaseManifest(reserved, 10)) as {
          retained: Array<{ ballot: unknown }>;
        }
      ).retained[0]?.ballot
    ).toBeNull();
  });
});
