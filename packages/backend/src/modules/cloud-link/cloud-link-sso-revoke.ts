import { and, inArray, isNull } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { users } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuthService, normalizeOidcIssuer } from '@/modules/auth/auth.service.js';
import { CloudLinkService } from './cloud-link.service.js';
import type { CloudSsoRevoke, CloudSsoRevokeResult } from './cloud-link.types.js';

const logger = createChildLogger('CloudSsoRevoke');

export interface CloudSsoRevokeDeps {
  db: DrizzleClient;
  auth: Pick<AuthService, 'blockUserForOpfieldAccount'>;
  cloud: Pick<CloudLinkService, 'recordSsoRevoke'>;
}

/** The forms an issuer is stored in (`users.oidc_issuer` holds the `iss` claim without trailing slashes). */
function issuerForms(issuer: string): string[] {
  const forms = new Set<string>();
  const plain = normalizeOidcIssuer(issuer);
  if (plain) forms.add(plain);
  try {
    const parsed = normalizeOidcIssuer(new URL(issuer.trim()).toString());
    if (parsed) forms.add(parsed);
  } catch {
    // Validated by the request handler; the plain form is enough.
  }
  return [...forms];
}

/**
 * The Opfield account removed people's access to this installation (removed from the team, access removed, the
 * installation moved to another account, or the account suspended): the accounts that signed in here as those
 * subjects of the account issuer are blocked as the Opfield account's, whichever provider is active now. Their
 * browser sessions end and their API, OAuth and MCP tokens are refused while blocked (not deleted); their next sign-in
 * through the same issuer lifts the block, which an administrator's block never is. Idempotent: an account blocked
 * already (by either) stays as it is and is reported as revoked; subjects without an account here are reported unknown.
 * The last active system administrator is never blocked (LAST_SYSTEM_ADMIN, reported as kept).
 */
export class CloudSsoRevoker {
  constructor(private readonly deps: CloudSsoRevokeDeps) {}

  async revoke(input: CloudSsoRevoke): Promise<CloudSsoRevokeResult> {
    const subjects = [...new Set(input.subjects)];
    const issuers = issuerForms(input.issuer);
    const rows =
      issuers.length === 0
        ? []
        : await this.deps.db
            .select({
              id: users.id,
              oidcSubject: users.oidcSubject,
              email: users.email,
              name: users.name,
              isBlocked: users.isBlocked,
              blockedBy: users.blockedBy,
            })
            .from(users)
            .where(
              and(inArray(users.oidcIssuer, issuers), inArray(users.oidcSubject, subjects), isNull(users.deletedAt))
            );
    const bySubject = new Map(rows.map((row) => [row.oidcSubject, row]));

    const revoked: CloudSsoRevokeResult['revoked'] = [];
    const unknown: string[] = [];
    const kept: NonNullable<CloudSsoRevokeResult['kept']> = [];
    const audited: Array<Record<string, unknown>> = [];
    for (const sub of subjects) {
      const row = bySubject.get(sub);
      if (!row) {
        unknown.push(sub);
        continue;
      }
      let outcome: 'blocked' | 'already_blocked' | 'kept' = 'already_blocked';
      let blockedBy: string | null = row.isBlocked ? (row.blockedBy ?? 'admin') : null;
      if (!row.isBlocked) {
        try {
          const blocked = await this.deps.auth.blockUserForOpfieldAccount(row.id);
          // Null: blocked meanwhile (by an administrator or another request); it stays blocked as it is.
          outcome = blocked ? 'blocked' : 'already_blocked';
          if (blocked) blockedBy = 'opfield_account';
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'LAST_SYSTEM_ADMIN') throw error;
          outcome = 'kept';
        }
      }
      if (outcome === 'kept') kept.push({ sub, userId: row.id, code: 'LAST_SYSTEM_ADMIN' });
      else revoked.push({ sub, userId: row.id });
      audited.push({
        userId: row.id,
        email: row.email,
        name: row.name,
        sub,
        outcome,
        ...(outcome === 'kept' ? { errorCode: 'LAST_SYSTEM_ADMIN' } : {}),
        ...(blockedBy ? { blockedBy } : {}),
      });
    }

    await this.deps.cloud.recordSsoRevoke({
      reason: input.reason,
      issuer: issuers[0] ?? input.issuer,
      subjects: subjects.length,
      blocked: audited.filter((entry) => entry.outcome === 'blocked').length,
      alreadyBlocked: audited.filter((entry) => entry.outcome === 'already_blocked').length,
      unknown: unknown.length,
      ...(kept.length ? { kept: kept.length } : {}),
      users: audited,
    });
    if (audited.length) {
      logger.info('The Opfield account removed access', {
        reason: input.reason,
        blocked: audited.filter((entry) => entry.outcome === 'blocked').length,
        kept: kept.length,
      });
    }
    return { revoked, unknown, ...(kept.length ? { kept } : {}) };
  }
}

/** The service as the running installation wires it. */
export function createCloudSsoRevoker(): CloudSsoRevoker {
  return new CloudSsoRevoker({
    db: container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
    auth: container.resolve(AuthService),
    cloud: container.resolve(CloudLinkService),
  });
}
