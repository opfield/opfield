import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import { gitLabUserCredentials, integrationConnectors } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { GitLabUserCredentialsService } from './gitlab-user-credentials.service.js';
import { GITLAB_AUDIT_ACTIONS } from './integration-audit.js';
import type {
  VcsConnectorAuth,
  VcsConnectorProvider,
  VcsRotatedToken,
  VcsTokenDescription,
} from './integration-provider.types.js';

const logger = createChildLogger('GitTokenMaintenance');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tokens are rotated this long before they expire; failures leave room for the 7-day alert. */
export const GIT_TOKEN_ROTATE_BEFORE_DAYS = 14;
/** Tokens that expire within this window are reported (shared tokens, failed rotations). */
const GIT_TOKEN_ALERT_WINDOW_DAYS = 30;
const MIN_ROTATED_LIFETIME_DAYS = 30;
/** GitLab refuses a rotated token that lives longer than a year. */
const MAX_ROTATED_LIFETIME_DAYS = 365;
/** Shorter lifetimes tried, in order, when the instance refuses a longer one. */
const ROTATION_LIFETIME_LADDER_DAYS = [365, 180, 90, 60, 30];
const SELF_ROTATE_SCOPES = new Set(['api', 'self_rotate']);
/** Answers that mean the token cannot rotate itself here (project/group token, no scope, old GitLab). */
const ROTATION_UNSUPPORTED_STATUSES = new Set([403, 404, 405, 501]);

type ConnectorRow = typeof integrationConnectors.$inferSelect;
type CredentialRow = typeof gitLabUserCredentials.$inferSelect;
type HolderKind = 'integration_connector' | 'gitlab_user_credential';

export interface GitTokenMaintenanceContext {
  db: DrizzleClient;
  /** The GitLab provider, when this edition has one. */
  provider: VcsConnectorProvider | undefined;
  credentials: GitLabUserCredentialsService;
  auditService: Pick<AuditService, 'log'>;
  encryptToken(token: string): string;
  decryptToken(encryptedToken: string): string;
  emitConnector(id: string, action: string): void;
}

/** An alert the expiry job raises once per token lifetime (keyed by `reason` and `expiresAt`). */
export interface GitTokenMaintenanceAlert {
  severity: 'warning' | 'critical';
  resourceType: HolderKind;
  resourceId: string;
  reason: 'git:shared-token' | 'git:rotation-lost';
  expiresAt: Date;
  message: string;
}

export interface GitTokenMaintenanceResult {
  described: number;
  rotated: number;
  failed: number;
  /**
   * `resourceType:id` of tokens that will rotate themselves before they
   * expire. Their 30- and 7-day expiry alerts are skipped; a token whose
   * rotation is impossible or failed is not listed and keeps its alerts.
   */
  autoRotating: string[];
  alerts: GitTokenMaintenanceAlert[];
}

interface TokenHolder {
  kind: HolderKind;
  id: string;
  label: string;
  connector: ConnectorRow;
  encryptedToken: string;
  token: string;
  recordedExpiresAt: Date | null;
  credential?: CredentialRow;
}

type RotationOutcome =
  | { outcome: 'rotated'; rotated: VcsRotatedToken }
  | { outcome: 'changed' }
  | { outcome: 'superseded'; rotated: VcsRotatedToken }
  | { outcome: 'unsupported'; error: unknown }
  | { outcome: 'failed'; error: unknown }
  | { outcome: 'lost'; error: unknown };

/** GitLab self-rotation needs the api or self_rotate scope on the token itself. */
export function canSelfRotate(scopes: readonly string[] | null | undefined): boolean {
  return !!scopes?.some((scope) => SELF_ROTATE_SCOPES.has(scope));
}

export function isRotationDue(expiresAt: Date | null | undefined, now: Date): boolean {
  return !!expiresAt && expiresAt.getTime() - now.getTime() <= GIT_TOKEN_ROTATE_BEFORE_DAYS * DAY_MS;
}

/** The previous lifetime of the token (30 days to a year); a year when unknown. */
export function previousLifetimeDays(description: Pick<VcsTokenDescription, 'expiresAt' | 'createdAt'> | null) {
  let lifetimeDays = MAX_ROTATED_LIFETIME_DAYS;
  if (description?.expiresAt && description.createdAt) {
    lifetimeDays = Math.round((description.expiresAt.getTime() - description.createdAt.getTime()) / DAY_MS);
  }
  return Math.min(MAX_ROTATED_LIFETIME_DAYS, Math.max(MIN_ROTATED_LIFETIME_DAYS, lifetimeDays));
}

/**
 * Lifetimes to request, longest first: the token's previous lifetime, then
 * shorter steps for an instance whose maximum lifetime is lower. A refusal
 * steps down only as far as the instance requires (not straight to 30 days).
 * The lifetime never grows back on its own: if the instance maximum is raised
 * later, the token keeps the shorter lifetime until someone replaces it.
 */
export function rotationLifetimeCandidates(
  description: Pick<VcsTokenDescription, 'expiresAt' | 'createdAt'> | null
): number[] {
  const previous = previousLifetimeDays(description);
  return [previous, ...ROTATION_LIFETIME_LADDER_DAYS.filter((days) => days < previous)];
}

function holderKey(holder: Pick<TokenHolder, 'kind' | 'id'>): string {
  return `${holder.kind}:${holder.id}`;
}

/**
 * Holders are grouped by the token alone: the same PAT stored under two
 * spellings of one GitLab (internal and external hostname, http and https)
 * is still one token that a rotation would revoke for both.
 */
function tokenIdentity(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number | null {
  return error instanceof AppError ? error.statusCode : null;
}

/**
 * Daily Git token maintenance, run by the expiry-alert job before it alerts.
 *
 * - Records the current expiry of every token-mode GitLab connector (older
 *   connectors never stored it).
 * - Self-rotates GitLab connector and personal tokens that expire within 14
 *   days, but only after `/personal_access_tokens/self` answered for that
 *   exact token in this run, and only when that token is stored in a single
 *   place: GitLab revokes the old token at once, so a copy kept by another
 *   connector or credential would trip GitLab's reuse detection and revoke the
 *   new token too.
 * - Each rotation holds a per-row advisory lock and writes the new token only
 *   if the stored one is unchanged. A rotation whose outcome is unknown
 *   re-checks the old token and raises a critical re-authorize alert when it
 *   no longer works, so a lost token is never silent.
 */
export async function runGitTokenMaintenance(
  ctx: GitTokenMaintenanceContext,
  now = new Date()
): Promise<GitTokenMaintenanceResult> {
  const result: GitTokenMaintenanceResult = { described: 0, rotated: 0, failed: 0, autoRotating: [], alerts: [] };
  const provider = ctx.provider;
  if (!provider?.describeToken) return result;

  const holders = await loadHolders(ctx, result);
  const groups = new Map<string, TokenHolder[]>();
  for (const holder of holders) {
    const key = tokenIdentity(holder.token);
    groups.set(key, [...(groups.get(key) ?? []), holder]);
  }

  for (const group of groups.values()) {
    const first = group[0]!;
    const auth: VcsConnectorAuth = { baseUrl: first.connector.baseUrl, token: first.token };
    let description: VcsTokenDescription | null = null;
    try {
      description = await provider.describeToken(auth);
    } catch {
      description = null;
    }
    if (description) {
      result.described += 1;
      for (const holder of group) {
        if (holder.kind === 'integration_connector') await recordConnectorExpiry(ctx, holder, description.expiresAt);
      }
    }
    const expiresAt =
      description?.expiresAt ??
      group
        .map((holder) => holder.recordedExpiresAt)
        .filter((value): value is Date => !!value)
        .sort((a, b) => a.getTime() - b.getTime())[0] ??
      null;

    if (group.length > 1) {
      if (expiresAt && expiresAt.getTime() - now.getTime() <= GIT_TOKEN_ALERT_WINDOW_DAYS * DAY_MS) {
        for (const holder of group) {
          const others = group.filter((other) => other !== holder).map((other) => other.label);
          result.alerts.push({
            severity: 'warning',
            resourceType: holder.kind,
            resourceId: holder.id,
            reason: 'git:shared-token',
            expiresAt,
            message: `The GitLab token of ${holder.label} is also stored in ${others.join(', ')}. Opfield does not rotate a token that is stored in more than one place, because rotating it revokes the copy the others still use. Give each of them its own token.`,
          });
        }
      }
      continue;
    }

    const holder = first;
    const rotatable =
      !!description &&
      canSelfRotate(description.scopes) &&
      typeof provider.rotateToken === 'function' &&
      holder.connector.enabled;
    if (!rotatable || !expiresAt) continue;
    if (!isRotationDue(expiresAt, now)) {
      result.autoRotating.push(holderKey(holder));
      continue;
    }
    if (expiresAt.getTime() <= now.getTime()) continue;

    const rotation = await rotateHolder(ctx, provider, holder, auth, description!);
    if (rotation.outcome === 'rotated') {
      result.rotated += 1;
      await auditRotation(ctx, holder, rotation.rotated);
      continue;
    }
    if (rotation.outcome === 'changed') continue;
    if (rotation.outcome === 'superseded') {
      await discardOrphanedToken(provider, holder, rotation.rotated);
      continue;
    }
    if (rotation.outcome === 'unsupported') {
      logger.info('GitLab token cannot rotate itself; the expiry alerts remain', {
        holder: holderKey(holder),
        error: errorMessage(rotation.error),
      });
      continue;
    }
    result.failed += 1;
    if (rotation.outcome === 'lost') {
      logger.error('GitLab token rotation did not complete and the stored token no longer answers', {
        holder: holderKey(holder),
        error: errorMessage(rotation.error),
      });
      result.alerts.push({
        severity: 'critical',
        resourceType: holder.kind,
        resourceId: holder.id,
        reason: 'git:rotation-lost',
        expiresAt,
        message: `Automatic rotation of the GitLab token of ${holder.label} did not complete (${errorMessage(rotation.error)}), and the stored token no longer works. GitLab may have issued a new token that Opfield could not keep. ${holder.kind === 'integration_connector' ? 'Rotate the connector token' : 'Authorize a new personal token'} now.`,
      });
    } else {
      logger.warn('GitLab token rotation failed; the stored token still works and the expiry alerts remain', {
        holder: holderKey(holder),
        error: errorMessage(rotation.error),
      });
    }
  }

  return result;
}

async function loadHolders(ctx: GitTokenMaintenanceContext, result: GitTokenMaintenanceResult) {
  const connectors = await ctx.db
    .select()
    .from(integrationConnectors)
    .where(
      and(
        eq(integrationConnectors.provider, 'gitlab'),
        eq(integrationConnectors.authMode, 'token'),
        isNotNull(integrationConnectors.encryptedToken)
      )
    );
  const connectorsById = new Map(connectors.map((connector) => [connector.id, connector]));
  const credentials = await ctx.credentials.listValid();
  const missing = [...new Set(credentials.map((row) => row.connectorId).filter((id) => !connectorsById.has(id)))];
  if (missing.length > 0) {
    const rows = await ctx.db.select().from(integrationConnectors).where(inArray(integrationConnectors.id, missing));
    for (const row of rows) connectorsById.set(row.id, row);
  }

  const holders: TokenHolder[] = [];
  for (const connector of connectors) {
    try {
      holders.push({
        kind: 'integration_connector',
        id: connector.id,
        label: `integration "${connector.name}"`,
        connector,
        encryptedToken: connector.encryptedToken!,
        token: ctx.decryptToken(connector.encryptedToken!),
        recordedExpiresAt: connector.tokenExpiresAt,
      });
    } catch (error) {
      result.failed += 1;
      logger.warn('Cannot read a GitLab connector token for maintenance', { connectorId: connector.id, error });
    }
  }
  for (const credential of credentials) {
    const connector = connectorsById.get(credential.connectorId);
    if (!connector || connector.provider !== 'gitlab') continue;
    try {
      holders.push({
        kind: 'gitlab_user_credential',
        id: credential.id,
        label: `the personal credential of GitLab user ${credential.gitlabUsername} for integration "${connector.name}"`,
        connector,
        encryptedToken: credential.encryptedToken,
        token: ctx.credentials.decryptToken(credential),
        recordedExpiresAt: credential.tokenExpiresAt,
        credential,
      });
    } catch (error) {
      result.failed += 1;
      logger.warn('Cannot read a personal GitLab token for maintenance', { credentialId: credential.id, error });
    }
  }
  return holders;
}

async function recordConnectorExpiry(ctx: GitTokenMaintenanceContext, holder: TokenHolder, expiresAt: Date | null) {
  if ((holder.recordedExpiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null)) return;
  await ctx.db
    .update(integrationConnectors)
    .set({ tokenExpiresAt: expiresAt, updatedAt: new Date() })
    .where(
      and(eq(integrationConnectors.id, holder.id), eq(integrationConnectors.encryptedToken, holder.encryptedToken))
    );
  holder.recordedExpiresAt = expiresAt;
}

async function rotateHolder(
  ctx: GitTokenMaintenanceContext,
  provider: VcsConnectorProvider,
  holder: TokenHolder,
  auth: VcsConnectorAuth,
  description: VcsTokenDescription
): Promise<RotationOutcome> {
  let rotatedAtProvider = false;
  try {
    return await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`gitlab-token-rotation:${holderKey(holder)}`}))`);
      if ((await storedEncryptedToken(tx, holder)) !== holder.encryptedToken) return { outcome: 'changed' as const };

      let rotated: VcsRotatedToken;
      try {
        rotated = await rotateWithLadder(provider, auth, description);
      } catch (error) {
        const status = statusOf(error);
        if (status !== null && ROTATION_UNSUPPORTED_STATUSES.has(status))
          return { outcome: 'unsupported' as const, error };
        // GitLab refused every requested date: nothing was rotated.
        if (status === 400) return { outcome: 'failed' as const, error };
        // Timeout, 5xx, network: GitLab may have rotated. Only a 401 for the
        // old token proves it; an outage during the re-check proves nothing.
        return (await oldTokenRevoked(provider, auth))
          ? { outcome: 'lost' as const, error }
          : { outcome: 'failed' as const, error };
      }
      rotatedAtProvider = true;

      // The user replaced or removed the token meanwhile: their choice stands.
      if (!(await storeRotated(ctx, tx, holder, rotated))) return { outcome: 'superseded' as const, rotated };
      return { outcome: 'rotated' as const, rotated };
    });
  } catch (error) {
    // After GitLab rotated, the old token is revoked: losing the new one is critical.
    return rotatedAtProvider ? { outcome: 'lost', error } : { outcome: 'failed', error };
  }
}

async function oldTokenRevoked(provider: VcsConnectorProvider, auth: VcsConnectorAuth): Promise<boolean> {
  try {
    await provider.describeToken?.(auth);
    return false;
  } catch (error) {
    return statusOf(error) === 401;
  }
}

/**
 * The stored token changed while GitLab rotated the old one, so the new token
 * belongs to nobody. Revoke it (best effort) and leave a trace in the log.
 */
async function discardOrphanedToken(provider: VcsConnectorProvider, holder: TokenHolder, rotated: VcsRotatedToken) {
  let revoked = false;
  if (provider.revokeToken) {
    try {
      await provider.revokeToken({ baseUrl: holder.connector.baseUrl, token: rotated.token });
      revoked = true;
    } catch (error) {
      logger.warn('Could not revoke the orphaned rotated GitLab token', {
        holder: holderKey(holder),
        error: errorMessage(error),
      });
    }
  }
  logger.warn('The stored GitLab token changed during an automatic rotation; the replacement stays in place', {
    holder: holderKey(holder),
    rotatedTokenLast4: rotated.token.slice(-4),
    rotatedTokenExpiresAt: rotated.expiresAt?.toISOString() ?? null,
    orphanedTokenRevoked: revoked,
  });
}

async function rotateWithLadder(
  provider: VcsConnectorProvider,
  auth: VcsConnectorAuth,
  description: VcsTokenDescription
): Promise<VcsRotatedToken> {
  if (!provider.rotateToken)
    throw new AppError(501, 'TOKEN_ROTATION_UNAVAILABLE', 'This provider cannot rotate tokens');
  let lastError: unknown;
  for (const days of rotationLifetimeCandidates(description)) {
    try {
      return await provider.rotateToken(auth, new Date(Date.now() + days * DAY_MS));
    } catch (error) {
      // 400: the instance refused this date (a lower maximum lifetime); try a shorter one.
      if (statusOf(error) !== 400) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function storedEncryptedToken(tx: DrizzleTransaction, holder: TokenHolder): Promise<string | null> {
  if (holder.kind === 'integration_connector') {
    const [row] = await tx
      .select({ encryptedToken: integrationConnectors.encryptedToken })
      .from(integrationConnectors)
      .where(eq(integrationConnectors.id, holder.id))
      .limit(1);
    return row?.encryptedToken ?? null;
  }
  const [row] = await tx
    .select({ encryptedToken: gitLabUserCredentials.encryptedToken })
    .from(gitLabUserCredentials)
    .where(eq(gitLabUserCredentials.id, holder.id))
    .limit(1);
  return row?.encryptedToken ?? null;
}

async function storeRotated(
  ctx: GitTokenMaintenanceContext,
  tx: DrizzleTransaction,
  holder: TokenHolder,
  rotated: VcsRotatedToken
): Promise<boolean> {
  if (holder.kind === 'gitlab_user_credential') {
    return ctx.credentials.storeRotated(
      holder.id,
      rotated.token,
      { scopes: rotated.scopes, expiresAt: rotated.expiresAt },
      { expectedEncryptedToken: holder.encryptedToken, executor: tx }
    );
  }
  const updated = await tx
    .update(integrationConnectors)
    .set({
      encryptedToken: ctx.encryptToken(rotated.token),
      tokenLast4: rotated.token.slice(-4),
      tokenExpiresAt: rotated.expiresAt,
      updatedAt: new Date(),
    })
    .where(
      and(eq(integrationConnectors.id, holder.id), eq(integrationConnectors.encryptedToken, holder.encryptedToken))
    )
    .returning({ id: integrationConnectors.id });
  return updated.length === 1;
}

async function auditRotation(ctx: GitTokenMaintenanceContext, holder: TokenHolder, rotated: VcsRotatedToken) {
  const expiresAt = rotated.expiresAt?.toISOString() ?? null;
  if (holder.kind === 'integration_connector') {
    await ctx.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.connectorTokenRotate,
      userId: null,
      resourceType: 'integration-connector',
      resourceId: holder.id,
      details: { name: holder.connector.name, automatic: true, tokenLast4: rotated.token.slice(-4), expiresAt },
    });
    ctx.emitConnector(holder.id, 'token-rotated');
  } else {
    await ctx.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.userCredentialRotate,
      userId: holder.credential?.userId ?? null,
      resourceType: 'integration-connector',
      resourceId: holder.connector.id,
      details: {
        connectorName: holder.connector.name,
        gitlabUsername: holder.credential?.gitlabUsername,
        automatic: true,
        expiresAt,
      },
    });
  }
  logger.info('GitLab token rotated before expiry', { holder: holderKey(holder), expiresAt });
}
