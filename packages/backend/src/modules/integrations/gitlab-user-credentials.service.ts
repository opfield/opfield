import { and, eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { gitLabUserCredentials, integrationConnectors, users } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { VcsConnectorAuth } from './integration-provider.types.js';

type CredentialRow = typeof gitLabUserCredentials.$inferSelect;

export interface ValidatedGitLabUserCredential {
  gitlabUserId: string;
  gitlabUsername: string;
  tokenScopes: string[];
  tokenExpiresAt: Date | null;
}

export interface SafeGitLabUserCredential {
  authorized: boolean;
  status: 'missing' | 'valid' | 'invalid';
  tokenMasked: string | null;
  gitlabUserId: string | null;
  gitlabUsername: string | null;
  tokenScopes: string[];
  tokenExpiresAt: Date | null;
  lastValidatedAt: Date | null;
}

export interface ResolvedGitLabUserCredential {
  auth: VcsConnectorAuth;
  scopes: string[];
  gitlabUserId: string;
  gitlabUsername: string;
}

export class GitLabUserCredentialsService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService
  ) {}

  async getStatus(userId: string, connectorId: string): Promise<SafeGitLabUserCredential> {
    const row = await this.find(userId, connectorId);
    if (!row) {
      return {
        authorized: false,
        status: 'missing',
        tokenMasked: null,
        gitlabUserId: null,
        gitlabUsername: null,
        tokenScopes: [],
        tokenExpiresAt: null,
        lastValidatedAt: null,
      };
    }

    // An expired token is kept (so the user sees when it lapsed) but no longer authorizes anything.
    const expired = isCredentialExpired(row);
    return {
      authorized: row.status === 'valid' && !expired,
      status: expired ? 'invalid' : row.status,
      tokenMasked: `****${row.tokenLast4}`,
      gitlabUserId: row.gitlabUserId,
      gitlabUsername: row.gitlabUsername,
      tokenScopes: row.tokenScopes,
      tokenExpiresAt: row.tokenExpiresAt,
      lastValidatedAt: row.lastValidatedAt,
    };
  }

  async replace(
    userId: string,
    connectorId: string,
    token: string,
    identity: ValidatedGitLabUserCredential
  ): Promise<SafeGitLabUserCredential> {
    const now = new Date();
    const encryptedToken = JSON.stringify(this.cryptoService.encryptString(token));
    await this.db
      .insert(gitLabUserCredentials)
      .values({
        userId,
        connectorId,
        encryptedToken,
        tokenLast4: token.slice(-4),
        gitlabUserId: identity.gitlabUserId,
        gitlabUsername: identity.gitlabUsername,
        tokenScopes: identity.tokenScopes,
        tokenExpiresAt: identity.tokenExpiresAt,
        status: 'valid',
        lastValidatedAt: now,
        invalidatedAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [gitLabUserCredentials.userId, gitLabUserCredentials.connectorId],
        set: {
          encryptedToken,
          tokenLast4: token.slice(-4),
          gitlabUserId: identity.gitlabUserId,
          gitlabUsername: identity.gitlabUsername,
          tokenScopes: identity.tokenScopes,
          tokenExpiresAt: identity.tokenExpiresAt,
          status: 'valid',
          lastValidatedAt: now,
          invalidatedAt: null,
          updatedAt: now,
        },
      });
    return this.getStatus(userId, connectorId);
  }

  async resolveAuth(
    userId: string,
    connectorId: string,
    baseUrl: string
  ): Promise<ResolvedGitLabUserCredential | null> {
    const row = await this.find(userId, connectorId);
    if (!row || row.status !== 'valid') return null;
    if (isCredentialExpired(row)) {
      const [connector] = await this.db
        .select({ provider: integrationConnectors.provider, name: integrationConnectors.name })
        .from(integrationConnectors)
        .where(eq(integrationConnectors.id, connectorId))
        .limit(1);
      throw new AppError(
        428,
        'GIT_CREDENTIAL_EXPIRED',
        `Your personal access token for this integration expired on ${row.tokenExpiresAt!.toISOString().slice(0, 10)}. Authorize a new token to continue.`,
        {
          provider: connector?.provider ?? 'gitlab',
          connectorId,
          connectorName: connector?.name,
          baseUrl,
          reason: 'expired',
          expiredAt: row.tokenExpiresAt!.toISOString(),
        }
      );
    }
    return {
      auth: {
        baseUrl,
        token: this.cryptoService.decryptString(JSON.parse(row.encryptedToken)),
      },
      scopes: row.tokenScopes,
      gitlabUserId: row.gitlabUserId,
      gitlabUsername: row.gitlabUsername,
    };
  }

  /**
   * Every valid credential of a user who is not blocked (token maintenance:
   * expiry, rotation and shared-token detection). A blocked user's token is
   * never rotated, so Opfield does not keep it alive.
   */
  async listValid(): Promise<CredentialRow[]> {
    const rows = await this.db
      .select({ credential: gitLabUserCredentials })
      .from(gitLabUserCredentials)
      .innerJoin(users, eq(users.id, gitLabUserCredentials.userId))
      .where(and(eq(gitLabUserCredentials.status, 'valid'), eq(users.isBlocked, false)));
    return rows.map((row) => row.credential);
  }

  decryptToken(row: Pick<CredentialRow, 'encryptedToken'>): string {
    return this.cryptoService.decryptString(JSON.parse(row.encryptedToken));
  }

  /**
   * Store a token the provider rotated in place of the credential's current
   * one, only while the stored token is still `expectedEncryptedToken`.
   * Returns whether the row was updated.
   */
  async storeRotated(
    id: string,
    token: string,
    rotated: { scopes: string[]; expiresAt: Date | null },
    options: { expectedEncryptedToken: string; executor?: DrizzleExecutor }
  ): Promise<boolean> {
    const now = new Date();
    const updated = await (options.executor ?? this.db)
      .update(gitLabUserCredentials)
      .set({
        encryptedToken: JSON.stringify(this.cryptoService.encryptString(token)),
        tokenLast4: token.slice(-4),
        ...(rotated.scopes.length > 0 ? { tokenScopes: rotated.scopes } : {}),
        tokenExpiresAt: rotated.expiresAt,
        status: 'valid',
        lastValidatedAt: now,
        invalidatedAt: null,
        updatedAt: now,
      })
      .where(
        and(eq(gitLabUserCredentials.id, id), eq(gitLabUserCredentials.encryptedToken, options.expectedEncryptedToken))
      )
      .returning({ id: gitLabUserCredentials.id });
    return updated.length === 1;
  }

  /**
   * Mark the credential invalid. With `token`, only while the stored token is
   * still that one: a request that read the token just before an automatic
   * rotation must not invalidate the newly stored token when GitLab rejects
   * the old one. Returns whether the credential was marked.
   */
  async markInvalid(userId: string, connectorId: string, options: { token?: string } = {}): Promise<boolean> {
    const now = new Date();
    const conditions = [eq(gitLabUserCredentials.userId, userId), eq(gitLabUserCredentials.connectorId, connectorId)];
    if (options.token !== undefined) {
      const row = await this.find(userId, connectorId);
      if (!row || this.decryptToken(row) !== options.token) return false;
      conditions.push(eq(gitLabUserCredentials.encryptedToken, row.encryptedToken));
    }
    const updated = await this.db
      .update(gitLabUserCredentials)
      .set({ status: 'invalid', invalidatedAt: now, updatedAt: now })
      .where(and(...conditions))
      .returning({ id: gitLabUserCredentials.id });
    return updated.length > 0;
  }

  async disconnect(userId: string, connectorId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(gitLabUserCredentials)
      .where(and(eq(gitLabUserCredentials.userId, userId), eq(gitLabUserCredentials.connectorId, connectorId)))
      .returning({ id: gitLabUserCredentials.id });
    return deleted.length > 0;
  }

  private async find(userId: string, connectorId: string): Promise<CredentialRow | null> {
    const [row] = await this.db
      .select()
      .from(gitLabUserCredentials)
      .where(and(eq(gitLabUserCredentials.userId, userId), eq(gitLabUserCredentials.connectorId, connectorId)))
      .limit(1);
    return row ?? null;
  }
}

function isCredentialExpired(row: Pick<CredentialRow, 'tokenExpiresAt'>, now = Date.now()): boolean {
  return !!row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= now;
}
