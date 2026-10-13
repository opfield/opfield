import bcrypt from 'bcryptjs';
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { nodes } from '@/db/schema/index.js';
import { isNodeEnrollmentTokenExpired, parseNodeEnrollmentToken } from '@/modules/nodes/node-enrollment-token.js';
import type { GrpcServerDeps } from '../server.js';

export async function findPendingNodeByEnrollmentToken(deps: GrpcServerDeps, token: string) {
  const parsedToken = parseNodeEnrollmentToken(token);

  if (parsedToken.kind === 'v2') {
    const [candidate] = await deps.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.status, 'pending'), eq(nodes.enrollmentTokenSelector, parsedToken.selector)))
      .limit(1);

    if (!candidate?.enrollmentTokenHash) {
      return null;
    }

    if (!(await bcrypt.compare(token, candidate.enrollmentTokenHash))) return null;
    return isNodeEnrollmentTokenExpired(candidate.enrollmentTokenExpiresAt) ? 'expired' : candidate;
  }

  if (parsedToken.kind !== 'legacy') {
    return null;
  }

  // Compatibility for pending nodes created before selector-based tokens.
  const legacyPendingNodes = await deps.db
    .select()
    .from(nodes)
    .where(and(eq(nodes.status, 'pending'), isNull(nodes.enrollmentTokenSelector)));

  let matchedNode = null;
  for (const node of legacyPendingNodes) {
    if (node.enrollmentTokenHash && (await bcrypt.compare(token, node.enrollmentTokenHash))) {
      if (!matchedNode) {
        matchedNode = node;
      }
    }
    // Compare every legacy candidate to avoid turning old tokens into a position oracle.
  }

  if (matchedNode && isNodeEnrollmentTokenExpired(matchedNode.enrollmentTokenExpiresAt)) return 'expired';
  return matchedNode;
}

/**
 * A re-enrollment token of an enrolled remote relay (RelayPoolService.issueRelayReenrollment).
 * The token is the authorization, exactly as for a first enrollment: single use, expiring, and
 * handed to the host by an administrator. It lets a relay whose pinned policy trust holds only
 * keys Opfield destroyed start over from the active key without leaving the pool. Enroll accepts
 * it only from the relay's own host.
 */
export async function findRelayNodeByReenrollmentToken(deps: GrpcServerDeps, token: string) {
  const parsedToken = parseNodeEnrollmentToken(token);
  if (parsedToken.kind !== 'v2') return null;
  const [candidate] = await deps.db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.type, 'relay'),
        ne(nodes.status, 'pending'),
        isNotNull(nodes.certificateSerial),
        eq(nodes.enrollmentTokenSelector, parsedToken.selector)
      )
    )
    .limit(1);
  if (!candidate?.enrollmentTokenHash) return null;
  if (!(await bcrypt.compare(token, candidate.enrollmentTokenHash))) return null;
  return isNodeEnrollmentTokenExpired(candidate.enrollmentTokenExpiresAt) ? 'expired' : candidate;
}
