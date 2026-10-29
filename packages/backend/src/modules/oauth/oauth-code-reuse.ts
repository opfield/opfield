import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { OAuthTokenLifecycle } from './oauth-token-lifecycle.js';

/** How long after an exchange a replay of its code still revokes the tokens it issued. */
const AUTH_CODE_REUSE_WINDOW_SECONDS = 24 * 60 * 60;

type CodeIssuedTokens = { refreshTokenId: string | null; accessTokenId: string | null };
type AuthorizationCodeRef = { id: string; clientId: string; userId: string };

function issuedTokensKey(codeId: string): string {
  return `oauth:code:${codeId}:tokens`;
}

function reusedKey(codeId: string): string {
  return `oauth:code:${codeId}:reused`;
}

/**
 * An authorization code presented a second time may be in other hands, so the tokens it was exchanged for are revoked
 * (RFC 6749 section 4.1.2). Remembers which tokens each code issued; a replay racing the first exchange leaves a mark
 * that exchange checks after issuing, so one of the two always sees the other.
 */
export class OAuthCodeReuseGuard {
  constructor(
    private readonly cache: Pick<CacheService, 'get' | 'set'>,
    private readonly lifecycle: Pick<OAuthTokenLifecycle, 'revokeIssuedTokens'>,
    private readonly audit: Pick<AuditService, 'log'>
  ) {}

  /** Records the tokens a code was exchanged for; true (and they are revoked) when the code was replayed meanwhile. */
  async recordIssued(code: AuthorizationCodeRef, issued: CodeIssuedTokens): Promise<boolean> {
    const tokens = { refreshTokenId: issued.refreshTokenId, accessTokenId: issued.accessTokenId };
    await this.cache.set(issuedTokensKey(code.id), tokens, AUTH_CODE_REUSE_WINDOW_SECONDS);
    if (!(await this.cache.get(reusedKey(code.id)))) return false;
    await this.lifecycle.revokeIssuedTokens(tokens);
    return true;
  }

  /** The code was already used: revokes what its exchange issued. */
  async revokeTokensOf(code: AuthorizationCodeRef): Promise<void> {
    await this.cache.set(reusedKey(code.id), true, AUTH_CODE_REUSE_WINDOW_SECONDS);
    const issued = await this.cache.get<CodeIssuedTokens>(issuedTokensKey(code.id));
    if (!issued) return;
    await this.lifecycle.revokeIssuedTokens(issued);
    await this.audit.log({
      userId: null,
      action: 'oauth.authorization_revoke',
      resourceType: 'oauth-client',
      resourceId: code.clientId,
      details: { reason: 'authorization_code_reuse', targetUserId: code.userId, codeId: code.id },
    });
  }
}
