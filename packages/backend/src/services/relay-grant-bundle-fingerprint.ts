import { createHash } from 'node:crypto';
import type { SignedRelayGrant } from '@/grpc/relay-control.client.js';
import type { RelayGrantBundle } from './relay-grant-issuer.service.js';

/** Claims that change on every signature, not with what a grant allows. */
const VOLATILE_CLAIMS = new Set(['grantId', 'issuedAt', 'notBefore', 'expiresAt']);

function grantContent(grant: SignedRelayGrant | undefined): unknown {
  if (!grant || typeof grant !== 'object' || grant.payload == null) return grant ?? null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(grant.payload).toString('utf8')) as Record<string, unknown>;
  } catch {
    // Not a claims document: compare it byte for byte.
    return { keyId: grant.keyId, payload: Buffer.from(grant.payload).toString('base64') };
  }
  return {
    keyId: grant.keyId,
    claims: Object.fromEntries(
      Object.entries(claims)
        .filter(([key]) => !VOLATILE_CLAIMS.has(key))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    ),
  };
}

/**
 * What a grant bundle allows, without the signatures and lifetimes that differ on every build.
 * Two bundles with the same fingerprint carry the same assignments, candidates, fences and runtime
 * settings; only the freshness of their grants can differ. The revision stays in: bundles also
 * reach daemons outside syncNodeGrantBundle (managed storage links send theirs directly), so a
 * bundle Opfield recorded may no longer be the one a daemon holds once the policy moved on.
 */
export function relayGrantBundleFingerprint(bundle: RelayGrantBundle): string {
  const content = {
    revision: bundle.revision,
    dataLanes: bundle.dataLanes ?? null,
    readChunkBytes: bundle.readChunkBytes ?? null,
    revocationFences: bundle.revocationFences ?? [],
    grants: bundle.grants.map(({ grant, candidates, ...assignment }) => ({
      ...assignment,
      grant: grantContent(grant),
      candidates: (candidates ?? []).map(({ grant: candidateGrant, ...candidate }) => ({
        ...candidate,
        grant: grantContent(candidateGrant),
      })),
    })),
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
