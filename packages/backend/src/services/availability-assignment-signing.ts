import { inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { relayPolicySigningKeys } from '@/db/schema/index.js';
import type { AvailabilityPrimaryAssignment } from '@/grpc/generated/types.js';
import type { RelayPolicySigningKeyService } from '@/services/relay-policy-signing-key.service.js';

/**
 * Manual pairs' primary assignments (decision 6) are signed by Opfield with the relay policy signing key, like lease
 * manifests: a member accepts an assignment, from Opfield or relayed by its peer over member-control, only with a
 * valid signature of a key it trusts (docker daemon `memberha.AssignmentStatement`, verified with the lease keychain).
 */
export const PRIMARY_ASSIGNMENT_DOMAIN = 'gateway-availability-member/primary-assignment/v1';

export interface PrimaryAssignmentInput {
  setId: string;
  primaryMemberId: string;
  generation: number | bigint;
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** domain || 0x00 || u32be(len) set id || u32be(len) primary member id || u64be(generation): the signed message. */
export function primaryAssignmentMessage(input: PrimaryAssignmentInput): Buffer {
  const generation = BigInt(input.generation);
  if (generation <= 0n) throw new Error('A primary assignment generation starts at 1');
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(generation);
  return Buffer.concat([
    Buffer.from(PRIMARY_ASSIGNMENT_DOMAIN, 'utf8'),
    Buffer.from([0]),
    lengthPrefixed(input.setId),
    lengthPrefixed(input.primaryMemberId),
    encoded,
  ]);
}

/** Signs primary assignments and attaches the policy keys the daemon trusts directly (authenticated stream, A4). */
export class AvailabilityAssignmentSigner {
  constructor(
    private readonly db: DrizzleClient,
    private readonly keys: Pick<RelayPolicySigningKeyService, 'signPayload'>
  ) {}

  async signPrimaryAssignment(input: PrimaryAssignmentInput): Promise<AvailabilityPrimaryAssignment> {
    const { signingKeyId, signature } = await this.keys.signPayload(primaryAssignmentMessage(input));
    const trusted = await this.db
      .select({
        keyId: relayPolicySigningKeys.keyId,
        publicKey: relayPolicySigningKeys.publicKey,
        fingerprint: relayPolicySigningKeys.publicKeyFingerprint,
      })
      .from(relayPolicySigningKeys)
      .where(inArray(relayPolicySigningKeys.status, ['pending', 'active', 'verification_only']));
    return {
      setId: input.setId,
      primaryMemberId: input.primaryMemberId,
      generation: String(input.generation),
      signingKeyId,
      signature,
      policyKeys: trusted
        .map((key) => ({
          keyId: key.keyId,
          publicKey: Buffer.from(key.publicKey, 'base64'),
          publicKeyFingerprint: key.fingerprint,
        }))
        .sort((left, right) => left.keyId.localeCompare(right.keyId)),
    };
  }
}
