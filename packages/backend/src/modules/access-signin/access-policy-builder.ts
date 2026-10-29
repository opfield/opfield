import type { AccessListUser, AccessRule, AccessSignInMethod } from '@/db/schema/index.js';
import type { SyncAccessPolicyCommand } from '@/grpc/generated/types.js';
import type { AccessVerificationKeyView } from './access-signing-key.service.js';

export interface AccessPolicyListSource {
  id: string;
  signInMethods: AccessSignInMethod[] | string[];
  skipIpRanges: string[];
  includeRules: AccessRule[];
  requireRules: AccessRule[];
  excludeRules: AccessRule[];
  users: AccessListUser[];
}

export interface AccessPolicySources {
  revision: number;
  signInOrigin: string;
  keys: AccessVerificationKeyView[];
  lists: AccessPolicyListSource[];
  /** Sessions revoked before they expired. */
  revokedSessions: Array<{ id: string; expiresAt: Date }>;
  serviceTokens: Array<{ id: string; clientId: string; secretSha256: string; expiresAt: Date | null }>;
  now: Date;
}

const unix = (date: Date) => Math.floor(date.getTime() / 1000);

function rules(list: AccessRule[]): Array<{ selector: string; values: string[] }> {
  return (list ?? []).map((rule) => ({ selector: rule.selector, values: [...(rule.values ?? [])] }));
}

/**
 * The full access policy every capable ingress node checks requests against. Basic authentication users travel only
 * for lists that offer basic; sessions and service tokens that already expired are left out (the daemon would drop
 * them anyway).
 */
export function buildAccessPolicyCommand(sources: AccessPolicySources): SyncAccessPolicyCommand {
  const now = sources.now.getTime();
  return {
    revision: String(sources.revision),
    signInOrigin: sources.signInOrigin,
    keys: sources.keys.map((key) => ({ keyId: key.keyId, publicKey: key.publicKey })),
    lists: sources.lists.map((list) => {
      const methods = [...(list.signInMethods ?? [])] as string[];
      return {
        id: list.id,
        signInMethods: methods,
        skipIpRanges: [...(list.skipIpRanges ?? [])],
        includeRules: rules(list.includeRules),
        requireRules: rules(list.requireRules),
        excludeRules: rules(list.excludeRules),
        basicAuthUsers: methods.includes('basic')
          ? (list.users ?? []).map((user) => ({ username: user.username, bcryptHash: user.passwordHash }))
          : [],
      };
    }),
    revokedSessions: sources.revokedSessions
      .filter((session) => session.expiresAt.getTime() > now)
      .map((session) => ({ sessionId: session.id, expiresAtUnix: String(unix(session.expiresAt)) })),
    serviceTokens: sources.serviceTokens
      .filter((token) => !token.expiresAt || token.expiresAt.getTime() > now)
      .map((token) => ({
        id: token.id,
        clientId: token.clientId,
        secretSha256: token.secretSha256,
        // 0: never expires.
        expiresAtUnix: String(token.expiresAt ? unix(token.expiresAt) : 0),
      })),
  };
}
