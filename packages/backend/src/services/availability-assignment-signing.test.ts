import { createPrivateKey, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AvailabilityAssignmentSigner, primaryAssignmentMessage } from './availability-assignment-signing.js';

// Ed25519 key from the seed 00..1f; the docker daemon's test checks the same signature over the same statement.
const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der',
  type: 'pkcs8',
});
const golden =
  'b5b708bd779fc33895015482f024b107820229cafee289e481a4d705af1525c7ca478d337afd6b6dcbeabd18a9b520abf3309d27cc27dfa8b1bc063269210401';
const input = {
  setId: '11111111-1111-4111-8111-111111111111',
  primaryMemberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  generation: 7,
};

describe('primary assignment signing', () => {
  it('signs the statement the daemon verifies (golden vector shared with the Go test)', () => {
    expect(sign(null, primaryAssignmentMessage(input), privateKey).toString('hex')).toBe(golden);
  });

  it('refuses a generation below 1', () => {
    expect(() => primaryAssignmentMessage({ ...input, generation: 0 })).toThrow();
  });

  it('returns the signed assignment with the policy keys the daemon trusts', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [
            { keyId: 'k2', publicKey: Buffer.from('b').toString('base64'), fingerprint: 'sha256:b' },
            { keyId: 'k1', publicKey: Buffer.from('a').toString('base64'), fingerprint: 'sha256:a' },
          ],
        }),
      }),
    };
    const keys = {
      signPayload: vi.fn(async (payload: Buffer) => ({
        signingKeyId: 'k1',
        signature: sign(null, payload, privateKey),
      })),
    };
    const signer = new AvailabilityAssignmentSigner(db as never, keys);
    const assignment = await signer.signPrimaryAssignment(input);
    expect(assignment.generation).toBe('7');
    expect(assignment.signingKeyId).toBe('k1');
    expect(assignment.signature?.toString('hex')).toBe(golden);
    expect(assignment.policyKeys?.map((key) => key.keyId)).toEqual(['k1', 'k2']);
  });
});
