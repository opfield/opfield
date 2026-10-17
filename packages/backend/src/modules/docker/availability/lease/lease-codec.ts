import { createHash } from 'node:crypto';
import type { DockerAvailabilityLeaseBallot } from '@/db/schema/index.js';
import { decodeRelayV1Message, encodeRelayV1Message } from '@/grpc/relay-proto.js';
import { LEGACY_AVAILABILITY_LEASE_DOMAIN } from '@/lib/legacy-compat.js';

/**
 * Byte-exact counterparts of daemon-shared/availabilitylease (crypto.go, keychain.go). Every signed byte string
 * starts with its domain and a zero byte, so a signature can never be replayed as another message type.
 */
export const LEASE_SIGNATURE_DOMAINS = {
  manifest: `${LEGACY_AVAILABILITY_LEASE_DOMAIN}/manifest/v1`,
  keyRotation: `${LEGACY_AVAILABILITY_LEASE_DOMAIN}/key-rotation/v1`,
} as const;

/** Voter configs travel inside manifests since A18; only manifests are signed as blocks. */
export type LeaseBlockKind = 'LEASE_BLOCK_KIND_MANIFEST';

export interface LeaseSignedBlockValue {
  signingKeyId: string;
  kind: LeaseBlockKind;
  payload: Buffer;
  signature: Buffer;
}

export interface LeaseKeyRotationValue {
  previousKeyId: string;
  keyId: string;
  publicKey: Buffer;
  publicKeyFingerprint: string;
  signature: Buffer;
}

export type LeaseSigner = (message: Buffer, keyId: string) => Promise<{ signingKeyId: string; signature: Buffer }>;

function statementPrefix(domain: string): Buffer {
  return Buffer.concat([Buffer.from(domain, 'utf8'), Buffer.from([0])]);
}

function lengthPrefixed(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

/** domain || 0x00 || payload: what the policy key signs for a manifest block. */
export function leaseBlockMessage(_kind: LeaseBlockKind, payload: Buffer): Buffer {
  return Buffer.concat([statementPrefix(LEASE_SIGNATURE_DOMAINS.manifest), payload]);
}

/** domain || 0x00 || be32(len(keyId)) || keyId || publicKey: what the previous key signs for a rotation link (A14). */
export function leaseKeyRotationMessage(keyId: string, publicKey: Buffer): Buffer {
  return Buffer.concat([
    statementPrefix(LEASE_SIGNATURE_DOMAINS.keyRotation),
    lengthPrefixed(Buffer.from(keyId, 'utf8')),
    publicKey,
  ]);
}

/** "sha256:<hex>" of a raw Ed25519 policy key, as the relay policy store and availabilitylease compute it. */
export function policyKeyFingerprint(publicKey: Buffer): string {
  return `sha256:${createHash('sha256').update(publicKey).digest('hex')}`;
}

export async function signLeaseBlock(
  kind: LeaseBlockKind,
  payload: Buffer,
  keyId: string,
  sign: LeaseSigner
): Promise<LeaseSignedBlockValue> {
  const signed = await sign(leaseBlockMessage(kind, payload), keyId);
  return { signingKeyId: signed.signingKeyId, kind, payload, signature: signed.signature };
}

export function encodeLeaseSignedBlock(block: LeaseSignedBlockValue): Buffer {
  return encodeRelayV1Message('LeaseSignedBlock', block);
}

export function decodeLeaseSignedBlock(encoded: Buffer): LeaseSignedBlockValue {
  const decoded = decodeRelayV1Message('LeaseSignedBlock', encoded) as {
    signingKeyId: string;
    kind: LeaseBlockKind;
    payload: Buffer;
    signature: Buffer;
  };
  return {
    signingKeyId: decoded.signingKeyId,
    kind: decoded.kind,
    payload: Buffer.from(decoded.payload),
    signature: Buffer.from(decoded.signature),
  };
}

export function encodeLeaseKeyRotation(link: LeaseKeyRotationValue): Buffer {
  return encodeRelayV1Message('LeasePolicyKeyRotation', link);
}

export interface LeaseManifestCandidate {
  id: string;
  /** PKIX DER ECDSA P-256 identity key. */
  publicKey: Buffer;
}

export interface LeaseManifestContent {
  policyId: string;
  mode: 'failover' | 'replicated';
  partitionMode: 'strict' | 'available';
  slots: number;
  /** Ordered: the index is the takeover rank (D5). */
  candidates: LeaseManifestCandidate[];
  specFingerprint: string;
  /** Per-policy voter epoch (A18); bumped on every voter change, never goes back. */
  voterEpoch: number;
  closed: boolean;
  bootstrapId: number;
  bootstrap: Array<{ slot: number; holderId: string }>;
  /** Voters (candidate hosts and witnesses) and every relay serving the policy as non-voting members. */
  members: Array<{ id: string; role: 'relay' | 'daemon'; publicKey: Buffer }>;
  /** One quorum set when settled, two (old, new) during a joint voter change. */
  quorumSets: string[][];
  /**
   * Graceful close (closed manifests only, relay.v1 LeaseManifest.retained = 16): per slot, the committed holder that
   * keeps its copy running without a lease once a majority of every quorum set confirmed the close to it. Undefined
   * on every other manifest, so their digest does not change.
   */
  retained?: LeaseRetainedSlot[];
  /** v3 (AS8): keys carry certified holder state; strict partition mode only. */
  stateful?: boolean;
}

/** A slot's retained holder in a closed manifest; holderId is one of the manifest's candidates. */
export interface LeaseRetainedSlot {
  slot: number;
  holderId: string;
  /**
   * The committed ballot Opfield saw; null for a reserved bootstrap holder Opfield saw no commit of (the close may have
   * raced its bootstrap commit: acceptors then confirm it on the commit they hold).
   */
  ballot: DockerAvailabilityLeaseBallot | null;
}

let statefulSupported: boolean | null = null;

/**
 * Whether this build's relay.v1.LeaseManifest has the v3 `stateful` field. Without it a stateful manifest would be
 * encoded as a stateless one (unknown fields are dropped), so the host never publishes a stateful policy then.
 */
export function leaseManifestSupportsStateful(): boolean {
  if (statefulSupported === null) {
    try {
      const decoded = decodeRelayV1Message('LeaseManifest', encodeRelayV1Message('LeaseManifest', { stateful: true }));
      statefulSupported = (decoded as { stateful?: unknown }).stateful === true;
    } catch {
      statefulSupported = false;
    }
  }
  return statefulSupported;
}

/** Serialized relay.v1.LeaseManifest; schema version 1 and the fixed 30 s term. */
export function encodeLeaseManifest(content: LeaseManifestContent, manifestVersion: number): Buffer {
  if (content.stateful && !leaseManifestSupportsStateful()) {
    throw new Error('This build cannot encode stateful lease manifests (relay.v1 LeaseManifest.stateful is missing)');
  }
  return encodeRelayV1Message('LeaseManifest', {
    ...(content.stateful ? { stateful: true } : {}),
    schemaVersion: 1,
    policyId: content.policyId,
    manifestVersion: String(manifestVersion),
    mode: content.mode === 'replicated' ? 'LEASE_POLICY_MODE_REPLICATED' : 'LEASE_POLICY_MODE_FAILOVER',
    partitionMode:
      content.partitionMode === 'available' ? 'LEASE_PARTITION_MODE_AVAILABLE' : 'LEASE_PARTITION_MODE_STRICT',
    slots: content.slots,
    candidates: content.candidates.map((candidate) => ({ id: candidate.id, publicKey: candidate.publicKey })),
    specFingerprint: content.specFingerprint,
    voterEpoch: String(content.voterEpoch),
    closed: content.closed,
    bootstrapId: String(content.bootstrapId),
    bootstrap: content.bootstrap.map((entry) => ({ slot: entry.slot, holderId: entry.holderId })),
    leaseTermMs: 30_000,
    members: content.members.map((member) => ({
      id: member.id,
      publicKey: member.publicKey,
      role: member.role === 'relay' ? 'LEASE_MEMBER_ROLE_RELAY' : 'LEASE_MEMBER_ROLE_DAEMON',
    })),
    quorumSets: content.quorumSets.map((voterIds) => ({ voterIds })),
    retained: content.closed
      ? (content.retained ?? []).map((entry) => ({
          slot: entry.slot,
          holderId: entry.holderId,
          ...(entry.ballot
            ? {
                ballot: {
                  round: entry.ballot.round,
                  incarnation: entry.ballot.incarnation,
                  proposerId: entry.ballot.proposerId,
                },
              }
            : {}),
        }))
      : [],
  });
}

/**
 * The published manifest of a policy: whether it is closed and, for a closed one, its retained holders. Null when
 * there is none or it cannot be read.
 */
export function leaseManifestClosure(
  manifestBlock: string | null | undefined
): { closed: boolean; retained: LeaseRetainedSlot[] } | null {
  if (!manifestBlock) return null;
  try {
    const block = decodeLeaseSignedBlock(Buffer.from(manifestBlock, 'base64'));
    const manifest = decodeRelayV1Message('LeaseManifest', block.payload) as {
      closed?: boolean;
      retained?: Array<{ slot?: number; holderId?: string; ballot?: Partial<DockerAvailabilityLeaseBallot> | null }>;
    };
    const retained = (manifest.retained ?? []).flatMap((entry) =>
      entry.holderId
        ? [{ slot: entry.slot ?? 0, holderId: entry.holderId, ballot: normalizeLeaseBallot(entry.ballot ?? undefined) }]
        : []
    );
    return { closed: manifest.closed === true, retained: manifest.closed === true ? retained : [] };
  } catch {
    return null;
  }
}

/** Candidate ids of a published manifest block (base64 relay.v1.LeaseSignedBlock); empty when there is none. */
export function leaseManifestCandidateIds(manifestBlock: string | null | undefined): string[] {
  if (!manifestBlock) return [];
  try {
    const block = decodeLeaseSignedBlock(Buffer.from(manifestBlock, 'base64'));
    const manifest = decodeRelayV1Message('LeaseManifest', block.payload) as { candidates?: Array<{ id?: string }> };
    return (manifest.candidates ?? []).flatMap((candidate) => (candidate.id ? [candidate.id] : []));
  } catch {
    return [];
  }
}

/**
 * Digest of everything a manifest says except its version: a new digest publishes a new version. A stateless
 * manifest digests exactly as before v3, so an upgrade publishes no new version of a running policy.
 */
export function leaseManifestDigest(content: LeaseManifestContent): string {
  const { stateful, ...rest } = content;
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...rest,
        candidates: content.candidates.map((candidate) => [candidate.id, candidate.publicKey.toString('base64')]),
        members: content.members.map((member) => [member.id, member.role, member.publicKey.toString('base64')]),
        ...(stateful ? { stateful: true } : {}),
      })
    )
    .digest('hex');
}

function uint(value: string | undefined): bigint {
  try {
    return BigInt(value || '0');
  } catch {
    return 0n;
  }
}

/** Ballots order by (round, incarnation, proposer), exactly like availabilitylease.Ballot.Compare. */
export function compareLeaseBallots(
  left: DockerAvailabilityLeaseBallot | null | undefined,
  right: DockerAvailabilityLeaseBallot | null | undefined
): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  const leftRound = uint(left.round);
  const rightRound = uint(right.round);
  if (leftRound !== rightRound) return leftRound < rightRound ? -1 : 1;
  const leftIncarnation = uint(left.incarnation);
  const rightIncarnation = uint(right.incarnation);
  if (leftIncarnation !== rightIncarnation) return leftIncarnation < rightIncarnation ? -1 : 1;
  if (left.proposerId === right.proposerId) return 0;
  return left.proposerId < right.proposerId ? -1 : 1;
}

export function normalizeLeaseBallot(
  value: { round?: string; incarnation?: string; proposerId?: string } | null | undefined
): DockerAvailabilityLeaseBallot | null {
  if (!value) return null;
  const ballot = {
    round: String(value.round ?? '0'),
    incarnation: String(value.incarnation ?? '0'),
    proposerId: String(value.proposerId ?? ''),
  };
  return ballot.round === '0' && ballot.incarnation === '0' && ballot.proposerId === '' ? null : ballot;
}
