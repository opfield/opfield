import { and, count, eq, inArray, isNotNull, isNull, ne, notLike, or, sql } from 'drizzle-orm';
import * as client from 'openid-client';
import { inject, injectable } from 'tsyringe';
import { getEnv } from '@/config/env.js';
import { TOKENS } from '@/container.js';
import type { DrizzleClient, DrizzleExecutor, DrizzleTransaction } from '@/db/client.js';
import {
  apiTokens,
  databaseConnections,
  domains,
  gitLabUserCredentials,
  inferenceOAuthSessions,
  inferenceTokens,
  loggingEnvironments,
  loggingSchemas,
  managedDatabaseInstances,
  managedStorageClusters,
  nodes,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
  objectStorageConnections,
  pageProjects,
  permissionGroups,
  proxyHosts,
  sslCertificates,
  type UserAuthMethod,
  userPasswordCredentials,
  users,
} from '@/db/schema/index.js';
import {
  type CreatedResourceDestination,
  type CreatedResourceFamily,
  createdResourceScopesForCreator,
} from '@/lib/created-resource-scopes.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { createChildLogger } from '@/lib/logger.js';
import { canManageUser, isScopeSubset } from '@/lib/permissions.js';
import { canonicalizeInboundScopes, canonicalizeScopes, isValidInboundScope } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { type LicenseQuotaService, requireConfiguredLicenseQuota } from '@/modules/license/license-quota.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { SessionService } from '@/services/session.service.js';
import type { User } from '@/types.js';
import type { AuthSettingsService } from './auth.settings.service.js';
import { type AvatarStorageService, isStoredAvatarUrl } from './avatar-storage.service.js';
import {
  computeEffectiveGroupAccess,
  computeEffectiveUserAccess,
  fetchGroupScopeMap,
  groupsRequireMfa,
  resolveEffectiveUserAccess,
  userGroupIds,
} from './live-session-user.js';
import { mfaRequiredChannel } from './mfa-events.js';
import type { OidcSettingsService } from './oidc-settings.service.js';
import { LEGACY_SYSTEM_ADMINS_GROUP } from '@/lib/legacy-compat.js';

const logger = createChildLogger('AuthService');

const PKCE_STATE_PREFIX = 'oidc:pkce:';
const PRECREATED_SUBJECT_PREFIX = 'manual:';
const SYSTEM_SUBJECT_PREFIX = 'system:';
/** Advisory lock serializing changes that can remove a system administrator. */
const SYSTEM_ADMINS_LOCK = LEGACY_SYSTEM_ADMINS_GROUP;
/** Subject namespaces Opfield writes itself; an identity provider must never be able to claim them. */
const RESERVED_SUBJECT_PREFIXES = [PRECREATED_SUBJECT_PREFIX, SYSTEM_SUBJECT_PREFIX] as const;
const OPFIELD_SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
export const AI_APPROVAL_MODES = ['always-ask', 'normal', 'bypass-non-destructive', 'bypass-everything'] as const;
export type AIApprovalMode = (typeof AI_APPROVAL_MODES)[number];

export interface DeletedUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  deletedAt: string;
  deletedByUserId: string | null;
  deletedFromGroupId: string | null;
  originalGroupExists: boolean;
}

export interface NormalizedOidcClaims {
  oidcSubject: string;
  /** Normalized issuer that asserted the subject; null only for legacy callers without an issuer. */
  oidcIssuer: string | null;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

export interface OidcSessionMetadata {
  ipAddress?: string;
  userAgent?: string;
}

/** Issuer identifiers are compared without trailing slashes so `https://idp/` and `https://idp` match. */
export function normalizeOidcIssuer(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : null;
}

export function normalizeOidcClaims(
  claims: Record<string, unknown> | undefined | null,
  fallbackIssuer?: string | null
): NormalizedOidcClaims {
  const subject = typeof claims?.sub === 'string' ? claims.sub : '';
  if (!subject) {
    throw new Error('No subject claim in ID token');
  }
  const lowerSubject = subject.trim().toLowerCase();
  if (RESERVED_SUBJECT_PREFIXES.some((prefix) => lowerSubject.startsWith(prefix))) {
    throw new Error('OIDC subject uses a reserved Opfield namespace');
  }

  const email = typeof claims?.email === 'string' ? claims.email.trim().toLowerCase() : '';

  return {
    oidcSubject: subject,
    oidcIssuer: normalizeOidcIssuer(typeof claims?.iss === 'string' ? claims.iss : fallbackIssuer),
    email: email || null,
    emailVerified: claims?.email_verified === true,
    name: typeof claims?.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
    avatarUrl: typeof claims?.picture === 'string' && claims.picture.trim() ? claims.picture : null,
  };
}

function normalizeDisplayName(name: string | null | undefined, fallbackEmail: string): string {
  return name?.trim() || fallbackEmail;
}

function isCustomAvatarUrl(value: string | null | undefined): boolean {
  return value?.startsWith('data:image/') === true || isStoredAvatarUrl(value);
}

interface OIDCState {
  codeVerifier: string;
  state: string;
  nonce?: string;
  returnTo?: string;
}

@injectable()
export class AuthService {
  private licenseQuota?: LicenseQuotaService;
  private avatarStorageService?: AvatarStorageService;

  private oidcConfig: client.Configuration | null = null;
  private oidcConfigKey: string | null = null;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly sessionService: SessionService,
    private readonly cacheService: CacheService,
    private readonly authSettingsService: AuthSettingsService,
    private readonly auditService: AuditService,
    private readonly oidcSettingsService?: OidcSettingsService,
    private readonly generalSettingsService?: GeneralSettingsService
  ) {}

  setLicenseQuotaService(service: LicenseQuotaService): void {
    this.licenseQuota = service;
  }

  setAvatarStorageService(service: AvatarStorageService): void {
    this.avatarStorageService = service;
  }

  private eventBus?: import('@/services/event-bus.service.js').EventBusService;
  private sandboxService?: AISandboxService;
  setEventBus(bus: import('@/services/event-bus.service.js').EventBusService) {
    this.eventBus = bus;
  }
  setSandboxService(service: AISandboxService) {
    this.sandboxService = service;
  }
  private emitUser(id: string, action: 'created' | 'updated' | 'deleted') {
    this.eventBus?.publish('user.changed', { id, action });
  }
  private emitPermissions(userId: string, scopes: string[], groupId: string | null, reason = 'permissions_changed') {
    this.eventBus?.publish(`permissions.changed.${userId}`, { scopes, groupId, reason });
    void this.sandboxService?.revokeUserAccess(userId, scopes, reason).catch((error) => {
      logger.warn('Failed to revoke sandbox jobs after permission change', { userId, reason, error });
    });
  }

  private async getOIDCConfig(): Promise<client.Configuration> {
    // Without stored settings (an embedded or test configuration) there is nothing a cached configuration could lag.
    if (!this.oidcSettingsService && this.oidcConfig) return this.oidcConfig;
    const runtime = (await this.oidcSettingsService?.getRuntimeConfig()) ?? null;
    if (!runtime) {
      throw new AppError(503, 'OIDC_NOT_CONFIGURED', 'OIDC is not configured');
    }
    // The configuration is read on every sign-in, so a client another replica saved (or the account portal rotated)
    // is used at once rather than after this replica restarts.
    const key = JSON.stringify([runtime.issuer, runtime.clientId, runtime.clientSecret]);
    if (this.oidcConfig && this.oidcConfigKey === key) {
      return this.oidcConfig;
    }

    try {
      this.oidcConfig = await client.discovery(new URL(runtime.issuer), runtime.clientId, runtime.clientSecret);
      this.oidcConfigKey = key;

      logger.info('OIDC configuration discovered', {
        issuer: runtime.issuer,
      });

      return this.oidcConfig;
    } catch (error) {
      logger.error('Failed to discover OIDC configuration', { error });
      throw new Error('OIDC configuration discovery failed');
    }
  }

  async grantCreatedResourcePermissions(
    userId: string,
    family: CreatedResourceFamily,
    resourceId: string,
    destination: CreatedResourceDestination = {}
  ): Promise<void> {
    const config = await (this.generalSettingsService ?? new GeneralSettingsService(this.db)).getConfig();
    if (!config.autoAssignCreatedResourcePermissions) return;
    const creatorRow = await this.db.query.users.findFirst({
      where: and(eq(users.id, userId), isNull(users.deletedAt)),
    });
    if (!creatorRow || creatorRow.isBlocked) return;
    // The creator always keeps view of what they made; everything else only when already held for this
    // resource (broadly, on its folder or node, or through an existing grant).
    const creator = await this.mapDbUserToUser(creatorRow);
    const stored =
      destination.folderId === undefined || destination.nodeId === undefined
        ? await this.createdResourceDestination(family, resourceId)
        : {};
    const grants = createdResourceScopesForCreator(family, resourceId, creator.scopes, {
      folderId: destination.folderId ?? stored.folderId ?? null,
      nodeId: destination.nodeId ?? stored.nodeId ?? null,
    });
    if (grants.length === 0) return;
    const [updated] = await this.db
      .update(users)
      .set({
        // Merge atomically so concurrent creations cannot overwrite one another or existing explicit grants.
        additionalScopes: sql`(SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb) FROM jsonb_array_elements(${users.additionalScopes} || ${JSON.stringify(grants)}::jsonb))`,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();
    if (!updated) return;
    const mapped = await this.mapDbUserToUser(updated);
    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, mapped.isBlocked ? [] : mapped.scopes, mapped.groupId, 'resource_created');
  }

  /** Tell the live sessions of these users that their stored grants were changed outside this service. */
  async announcePermissionsChanged(userIds: readonly string[], reason: string): Promise<void> {
    for (const userId of new Set(userIds)) {
      const row = await this.db.query.users.findFirst({ where: and(eq(users.id, userId), isNull(users.deletedAt)) });
      if (!row) continue;
      const mapped = await this.mapDbUserToUser(row);
      this.emitUser(userId, 'updated');
      this.emitPermissions(userId, mapped.isBlocked ? [] : mapped.scopes, mapped.groupId, reason);
    }
  }

  /**
   * Where a created resource lives, read from its row, so creator grants do not depend on every
   * caller passing the destination. Docker resources carry their node in the ID; their folder must be
   * passed by the caller. Best effort: an unknown family or a failed lookup yields no destination.
   */
  private async createdResourceDestination(
    family: CreatedResourceFamily,
    resourceId: string
  ): Promise<CreatedResourceDestination> {
    const byId = async (table: any, withNode: boolean): Promise<CreatedResourceDestination> => {
      const [row] = await this.db
        .select(withNode ? { folderId: table.folderId, nodeId: table.nodeId } : { folderId: table.folderId })
        .from(table)
        .where(eq(table.id, resourceId))
        .limit(1);
      return (row as CreatedResourceDestination | undefined) ?? {};
    };
    const managedNode = async (table: any, column: any): Promise<string | null> => {
      const [row] = await this.db.select({ nodeId: table.nodeId }).from(table).where(eq(column, resourceId)).limit(1);
      return (row as { nodeId: string | null } | undefined)?.nodeId ?? null;
    };
    try {
      switch (family) {
        case 'proxy':
          return await byId(proxyHosts, true);
        case 'pages':
          return await byId(pageProjects, true);
        case 'domains':
          return await byId(domains, false);
        case 'ssl:cert':
          return await byId(sslCertificates, false);
        case 'nodes':
          return await byId(nodes, false);
        case 'logs:environments':
          return await byId(loggingEnvironments, false);
        case 'logs:schemas':
          return await byId(loggingSchemas, false);
        case 'admin:users':
          return await byId(users, false);
        case 'admin:groups':
          return await byId(permissionGroups, false);
        case 'databases':
          return {
            ...(await byId(databaseConnections, false)),
            nodeId: await managedNode(managedDatabaseInstances, managedDatabaseInstances.databaseConnectionId),
          };
        case 'storage':
          return {
            ...(await byId(objectStorageConnections, false)),
            nodeId: await managedNode(managedStorageClusters, managedStorageClusters.objectStorageConnectionId),
          };
        default:
          return {};
      }
    } catch (error) {
      logger.warn('Could not read the destination of a created resource', { family, resourceId, error });
      return {};
    }
  }

  async getAuthorizationUrl(returnTo?: string): Promise<string> {
    await this.assertAuthMethodEnabled('oidc');
    const runtime = (await this.oidcSettingsService?.getRuntimeConfig()) ?? null;
    const config = await this.getOIDCConfig();
    if (!runtime) throw new AppError(503, 'OIDC_NOT_CONFIGURED', 'OIDC is not configured');

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    const oidcState: OIDCState = {
      codeVerifier,
      state,
      nonce,
      returnTo,
    };

    await this.cacheService.set(`${PKCE_STATE_PREFIX}${state}`, oidcState, 300);

    const parameters: Record<string, string> = {
      redirect_uri: runtime.redirectUri,
      scope: runtime.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    };

    const authorizationUrl = client.buildAuthorizationUrl(config, parameters);

    return authorizationUrl.href;
  }

  async handleCallback(
    callbackUrl: string,
    state: string,
    sessionMetadata: OidcSessionMetadata = {}
  ): Promise<{ sessionId: string; user: User; returnTo?: string }> {
    // Settings can change while the user is at the identity provider. Do not
    // accept a callback for a method that has been disabled in the meantime.
    await this.assertAuthMethodEnabled('oidc');
    const config = await this.getOIDCConfig();
    const runtime = (await this.oidcSettingsService?.getRuntimeConfig()) ?? null;

    const oidcState = await this.cacheService.get<OIDCState>(`${PKCE_STATE_PREFIX}${state}`);

    if (!oidcState) {
      throw new Error('Invalid or expired state parameter');
    }

    await this.cacheService.delete(`${PKCE_STATE_PREFIX}${state}`);

    if (oidcState.state !== state) {
      throw new Error('State mismatch');
    }

    try {
      const tokens = await client.authorizationCodeGrant(config, new URL(callbackUrl), {
        pkceCodeVerifier: oidcState.codeVerifier,
        expectedState: state,
        expectedNonce: oidcState.nonce,
      });

      const normalizedClaims = normalizeOidcClaims(
        tokens.claims() as Record<string, unknown> | undefined | null,
        runtime?.issuer ?? null
      );
      const user = await this.findOrCreateUser(normalizedClaims);

      const { sessionId } = await this.sessionService.createSession(user, tokens.access_token, tokens.refresh_token, {
        authMethod: 'oidc',
        ...sessionMetadata,
      });
      await this.recordSuccessfulSignIn(user.id);

      logger.info('User logged in', { userId: user.id, email: user.email });

      return {
        sessionId,
        user,
        returnTo: oidcState.returnTo,
      };
    } catch (error) {
      logger.error('OIDC callback handling failed', { error });
      throw error;
    }
  }

  private async findOrCreateUser(data: NormalizedOidcClaims): Promise<User> {
    const normalizedEmail = data.email;

    let existingUser = await this.db.query.users.findFirst({
      where: eq(users.oidcSubject, data.oidcSubject),
    });

    if (existingUser) {
      // Subjects are only unique per issuer. Once an account has been bound to
      // an issuer, the same `sub` from any other issuer is a different person.
      if (existingUser.oidcIssuer && existingUser.oidcIssuer !== data.oidcIssuer) {
        throw new AppError(
          403,
          'OIDC_ISSUER_MISMATCH',
          'This account is linked to a different identity provider. Contact an administrator.'
        );
      }
      if (existingUser.deletedAt) {
        throw new AppError(
          403,
          'ACCOUNT_DELETED',
          'This account has been deleted and must be restored by a system administrator'
        );
      }
      // The Opfield account removed this person's access (sso-revoke); signing in through the same issuer again means
      // it gave the access back, so its block is lifted. An administrator's block is never lifted by a sign-in.
      const lifted = await this.liftOpfieldAccountBlock(existingUser, data.oidcIssuer);
      if (lifted) existingUser = lifted;
      // Accounts created before issuers were recorded are bound on their
      // next login under the currently configured issuer.
      const bindIssuer = !existingUser.oidcIssuer && data.oidcIssuer !== null;
      const authSettings = await this.authSettingsService.getConfig();
      const canSyncEmail =
        normalizedEmail !== null &&
        (!authSettings.oidcRequireVerifiedEmail || data.emailVerified || existingUser.email === normalizedEmail);
      const nextEmail = canSyncEmail ? normalizedEmail : existingUser.email;
      const nextName = normalizeDisplayName(data.name, existingUser.name?.trim() || nextEmail);
      const nextAvatarUrl = isCustomAvatarUrl(existingUser.avatarUrl) ? existingUser.avatarUrl : data.avatarUrl;

      if (
        bindIssuer ||
        existingUser.email !== nextEmail ||
        existingUser.name !== nextName ||
        existingUser.avatarUrl !== nextAvatarUrl
      ) {
        const [updatedUser] = await this.db
          .update(users)
          .set({
            ...(bindIssuer ? { oidcIssuer: data.oidcIssuer } : {}),
            email: nextEmail,
            name: nextName,
            avatarUrl: nextAvatarUrl,
            updatedAt: new Date(),
          })
          .where(
            bindIssuer ? and(eq(users.id, existingUser.id), isNull(users.oidcIssuer)) : eq(users.id, existingUser.id)
          )
          .returning();
        if (!updatedUser) {
          throw new AppError(409, 'OIDC_ACCOUNT_CHANGED', 'The account changed during sign-in. Try again.');
        }

        await this.auditService.log({
          userId: updatedUser.id,
          action: 'auth.user_profile_sync',
          resourceType: 'user',
          resourceId: updatedUser.id,
          details: {
            oidcSubject: data.oidcSubject,
            emailChanged: existingUser.email !== nextEmail,
            emailClaimIgnored:
              normalizedEmail !== null && existingUser.email !== normalizedEmail && nextEmail === existingUser.email,
            emailClaimMissing: normalizedEmail === null,
            emailVerified: data.emailVerified,
            ...(bindIssuer ? { oidcIssuerBound: data.oidcIssuer } : {}),
            nameChanged: existingUser.name !== nextName,
            avatarChanged: existingUser.avatarUrl !== nextAvatarUrl,
          },
        });

        return this.mapDbUserToUser(updatedUser);
      }

      return this.mapDbUserToUser(existingUser);
    }

    if (!normalizedEmail) {
      throw new Error('No email claim in ID token');
    }

    const precreatedUser = await this.db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });

    if (precreatedUser?.oidcSubject?.startsWith(PRECREATED_SUBJECT_PREFIX)) {
      await this.requireVerifiedEmailForNonBootstrap(data);
      const previousSubject = precreatedUser.oidcSubject;
      const [claimedUser] = await this.db
        .update(users)
        .set({
          oidcSubject: data.oidcSubject,
          oidcIssuer: data.oidcIssuer,
          email: normalizedEmail,
          name: normalizeDisplayName(data.name, precreatedUser.name?.trim() || normalizedEmail),
          avatarUrl: data.avatarUrl,
          updatedAt: new Date(),
        })
        .where(eq(users.id, precreatedUser.id))
        .returning();

      logger.info('Claimed pre-created user on first login', {
        userId: claimedUser.id,
        email: claimedUser.email,
      });

      await this.auditService.log({
        userId: claimedUser.id,
        action: 'auth.user_claimed',
        resourceType: 'user',
        resourceId: claimedUser.id,
        details: {
          email: claimedUser.email,
          previousOidcSubject: previousSubject,
          oidcSubject: data.oidcSubject,
          oidcIssuer: data.oidcIssuer,
          emailVerified: data.emailVerified,
        },
      });

      this.emitUser(claimedUser.id, 'updated');
      const mapped = await this.mapDbUserToUser(claimedUser);
      this.emitPermissions(mapped.id, mapped.scopes, mapped.groupId);
      return mapped;
    }

    await this.requireVerifiedEmailForNonBootstrap(data);
    const group = await this.resolveOidcProvisioningGroup();

    if (!group) {
      throw new Error('Default OIDC group not found. Has the migration been run?');
    }

    const insertUser = async (executor: DrizzleExecutor) => {
      const [createdUser] = await executor
        .insert(users)
        .values({
          oidcSubject: data.oidcSubject,
          oidcIssuer: data.oidcIssuer,
          email: normalizedEmail,
          name: normalizeDisplayName(data.name, normalizedEmail),
          avatarUrl: data.avatarUrl,
          groupId: group.id,
        })
        .returning();
      return createdUser;
    };
    const createdUser = await requireConfiguredLicenseQuota(this.licenseQuota).run(
      'users',
      (tx) => this.countActiveUsers(tx),
      insertUser
    );

    logger.info('Created new user', { userId: createdUser.id, email: createdUser.email, group: group.name });
    await this.auditService.log({
      userId: createdUser.id,
      action: 'auth.user_provisioned',
      resourceType: 'user',
      resourceId: createdUser.id,
      details: {
        email: createdUser.email,
        group: group.name,
        oidcSubject: data.oidcSubject,
        oidcIssuer: data.oidcIssuer,
        emailVerified: data.emailVerified,
        bootstrap: false,
      },
    });
    this.emitUser(createdUser.id, 'created');
    const mapped = await this.mapDbUserToUser(createdUser);
    this.emitPermissions(mapped.id, mapped.scopes, mapped.groupId);
    return mapped;
  }

  /**
   * Lifts the Opfield account's block of an account that signed in through the issuer it is bound to; the updated row,
   * or null when there was no such block (none, an administrator's, or another issuer).
   */
  private async liftOpfieldAccountBlock(
    user: typeof users.$inferSelect,
    issuer: string | null
  ): Promise<typeof users.$inferSelect | null> {
    if (!user.isBlocked || user.blockedBy !== 'opfield_account' || !user.oidcIssuer || user.oidcIssuer !== issuer) {
      return null;
    }
    const [lifted] = await this.db
      .update(users)
      .set({ isBlocked: false, blockedBy: null, updatedAt: new Date() })
      .where(
        and(
          eq(users.id, user.id),
          isNull(users.deletedAt),
          eq(users.isBlocked, true),
          eq(users.blockedBy, 'opfield_account'),
          eq(users.oidcIssuer, user.oidcIssuer)
        )
      )
      .returning();
    if (!lifted) return null;
    await this.auditService.log({
      userId: lifted.id,
      action: 'user.opfield_account_unblock',
      resourceType: 'user',
      resourceId: lifted.id,
      details: {
        targetUserId: lifted.id,
        targetUserEmail: lifted.email,
        targetUserName: lifted.name,
        oidcIssuer: user.oidcIssuer,
        blockedBy: 'opfield_account',
      },
    });
    logger.info('Lifted the block of the Opfield account on sign-in', { userId: lifted.id });
    const mapped = await this.mapDbUserToUser(lifted);
    this.emitUser(lifted.id, 'updated');
    this.emitPermissions(lifted.id, mapped.scopes, mapped.groupId ?? null);
    return lifted;
  }

  invalidateOidcConfiguration(): void {
    this.oidcConfig = null;
    this.oidcConfigKey = null;
  }

  private async requireVerifiedEmailForNonBootstrap(data: NormalizedOidcClaims): Promise<void> {
    const authSettings = await this.authSettingsService.getConfig();
    if (!authSettings.oidcRequireVerifiedEmail || data.emailVerified) return;

    throw new AppError(
      403,
      'OIDC_EMAIL_NOT_VERIFIED',
      'OIDC email verification is required for this account. Contact an administrator.'
    );
  }

  private async resolveOidcProvisioningGroup() {
    const authSettings = await this.authSettingsService.getConfig();
    if (!authSettings.oidcAutoCreateUsers) {
      throw new Error('Your account has not been provisioned yet. Contact an administrator.');
    }

    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, authSettings.oidcDefaultGroupId),
    });
    return group ?? null;
  }

  async createUser(data: {
    folderId?: string | null;
    email: string;
    name?: string | null;
    groupId: string;
    groupIds?: string[];
    authMethod?: UserAuthMethod;
  }): Promise<User> {
    const normalizedEmail = data.email.trim().toLowerCase();
    const normalizedName = data.name?.trim();
    if (!normalizedName) throw new AppError(400, 'USER_NAME_REQUIRED', 'Name is required');
    const authMethod = data.authMethod ?? 'oidc';
    await this.assertAuthMethodEnabled(authMethod);

    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, data.groupId),
    });
    if (!group) {
      throw new Error('Permission group not found');
    }

    const existingByEmail = await this.db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });
    if (existingByEmail) {
      throw new Error('User with this email already exists');
    }

    const insertUser = async (executor: DrizzleExecutor) => {
      const groupIds = userGroupIds(data.groupId, data.groupIds);
      const assignedGroups = await executor
        .select({ id: permissionGroups.id })
        .from(permissionGroups)
        .where(inArray(permissionGroups.id, groupIds))
        .orderBy(permissionGroups.id)
        .for('key share');
      if (assignedGroups.length !== groupIds.length)
        throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
      const [createdUser] = await executor
        .insert(users)
        .values({
          oidcSubject: authMethod === 'oidc' ? `${PRECREATED_SUBJECT_PREFIX}${normalizedEmail}` : null,
          authMethod,
          email: normalizedEmail,
          name: normalizedName,
          avatarUrl: null,
          groupId: data.groupId,
          additionalGroupIds: groupIds.slice(1),
          folderId: data.folderId ?? null,
        })
        .returning();
      return createdUser;
    };
    const createdUser = await requireConfiguredLicenseQuota(this.licenseQuota).run(
      'users',
      (tx) => this.countActiveUsers(tx),
      insertUser
    );

    logger.info('Pre-created user', {
      userId: createdUser.id,
      email: createdUser.email,
      groupId: createdUser.groupId,
    });

    this.emitUser(createdUser.id, 'created');
    const mapped = await this.mapDbUserToUser(createdUser);
    this.emitPermissions(mapped.id, mapped.scopes, mapped.groupId);
    return mapped;
  }

  async updateUserAuthMethod(userId: string, authMethod: UserAuthMethod): Promise<User> {
    await this.assertAuthMethodEnabled(authMethod);
    const target = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (target.deletedAt) {
      throw new AppError(409, 'USER_DELETED', 'Deleted users must be restored before they can be changed');
    }
    if (target.oidcSubject?.startsWith(SYSTEM_SUBJECT_PREFIX)) {
      throw new AppError(403, 'SYSTEM_USER', 'Cannot change the Opfield system user authentication method');
    }
    if (target.authMethod === authMethod) return this.mapDbUserToUser(target);

    const [updated] = await this.db
      .update(users)
      .set({
        authMethod,
        oidcSubject: authMethod === 'oidc' ? `${PRECREATED_SUBJECT_PREFIX}${target.email}` : null,
        oidcIssuer: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    // Never carry a previous password across a primary-method transition.
    // Switching to password is activated by a fresh, emailed setup link.
    await this.db.delete(userPasswordCredentials).where(eq(userPasswordCredentials.userId, userId));
    await this.sessionService.destroyAllUserSessions(userId);
    this.emitUser(userId, 'updated');
    const mapped = await this.mapDbUserToUser(updated);
    this.emitPermissions(mapped.id, mapped.scopes, mapped.groupId);
    return mapped;
  }

  async updateLocalUserName(userId: string, name: string): Promise<User> {
    const target = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (target.authMethod === 'oidc') {
      throw new AppError(409, 'OIDC_NAME_MANAGED', 'OIDC user names are managed by the identity provider');
    }
    const [updated] = await this.db
      .update(users)
      .set({ name: name.trim(), updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    this.emitUser(userId, 'updated');
    return this.mapDbUserToUser(updated);
  }

  async updateUserAvatar(userId: string, avatarUrl: string | null): Promise<User> {
    const previous = this.avatarStorageService
      ? await this.db.query.users.findFirst({ where: eq(users.id, userId), columns: { avatarUrl: true } })
      : null;
    const [updated] = await this.db
      .update(users)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();
    if (!updated) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (previous?.avatarUrl && previous.avatarUrl !== avatarUrl) {
      await this.avatarStorageService?.removeByUrl(previous.avatarUrl).catch((error) => {
        logger.warn('Failed to remove replaced avatar file', { userId, error });
      });
    }
    this.emitUser(userId, 'updated');
    return this.mapDbUserToUser(updated);
  }

  async uploadUserAvatar(userId: string, file: File): Promise<User> {
    if (!this.avatarStorageService) {
      throw new AppError(503, 'AVATAR_STORAGE_UNAVAILABLE', 'Avatar storage is unavailable');
    }
    const avatarUrl = await this.avatarStorageService.store(file);
    try {
      return await this.updateUserAvatar(userId, avatarUrl);
    } catch (error) {
      await this.avatarStorageService.removeByUrl(avatarUrl).catch(() => {});
      throw error;
    }
  }

  async hasCompletedSignIn(userId: string): Promise<boolean> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { lastLoginAt: true },
    });
    return Boolean(user?.lastLoginAt);
  }

  async recordSuccessfulSignIn(userId: string): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  }

  private async assertAuthMethodEnabled(authMethod: UserAuthMethod): Promise<void> {
    const methods = (await this.authSettingsService.getConfig()).methods;
    const enabled =
      authMethod === 'oidc' ? methods?.oidc : authMethod === 'password' ? methods?.password : methods?.emailOtp;
    // Older test/config fixtures may not yet contain the methods object; a
    // persisted production configuration is normalized by AuthSettingsService.
    if (enabled === false) throw new AppError(409, 'AUTH_METHOD_DISABLED', 'This sign-in method is disabled');
  }

  private async mapDbUserToUser(dbUser: typeof users.$inferSelect): Promise<User> {
    const effective = await resolveEffectiveUserAccess(
      this.db,
      dbUser.groupId,
      dbUser.additionalScopes,
      dbUser.additionalGroupIds
    );
    const effectiveScopes = dbUser.deletedAt ? [] : await expandFolderScopes(this.db, effective.scopes);
    const isDeleted = Boolean(dbUser.deletedAt);

    return {
      id: dbUser.id,
      oidcSubject: dbUser.oidcSubject,
      authMethod: dbUser.authMethod,
      email: dbUser.email,
      name: dbUser.name,
      avatarUrl: dbUser.avatarUrl,
      groupId: dbUser.groupId,
      groupName: effective.groupName,
      groupIds: effective.groupIds,
      groupNames: effective.groupNames,
      require2fa: effective.require2fa,
      groupScopes: isDeleted ? [] : effective.groupScopes,
      additionalScopes: effective.additionalScopes,
      scopes: effectiveScopes,
      isBlocked: dbUser.isBlocked || isDeleted,
      blockedBy: dbUser.isBlocked ? (dbUser.blockedBy ?? 'admin') : null,
      isDeleted,
      aiApprovalMode: dbUser.aiApprovalMode,
    };
  }

  async logout(sessionId: string): Promise<string | null> {
    const session = await this.sessionService.getSession(sessionId).catch(() => null);
    await this.sessionService.destroySession(sessionId);

    // Only OIDC sessions have an identity-provider session to end. Local
    // installs have no OIDC configuration at all, and discovery failures must
    // never turn a completed local logout into an error.
    if (session?.authMethod && session.authMethod !== 'oidc') return null;
    try {
      if (!(await this.oidcSettingsService?.getRuntimeConfig())) return null;
      const config = await this.getOIDCConfig();
      const env = getEnv();
      const publicUrl = this.generalSettingsService
        ? await this.generalSettingsService.requirePublicUrl()
        : env.APP_URL;
      const metadata = config.serverMetadata();
      if (metadata.end_session_endpoint) {
        const logoutUrl = new URL(metadata.end_session_endpoint);
        logoutUrl.searchParams.set('post_logout_redirect_uri', publicUrl);
        return logoutUrl.href;
      }
    } catch (error) {
      logger.debug('No identity-provider logout URL for this session', { error });
    }

    return null;
  }

  async getUserById(userId: string): Promise<User | null> {
    const dbUser = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    return dbUser ? this.mapDbUserToUser(dbUser) : null;
  }

  async getUserPreferences(userId: string): Promise<{
    aiApprovalMode: AIApprovalMode;
    preferredInterface: 'ai_workspace' | 'operations_console' | null;
    preferredInterfaceSelectedAt: string | null;
  } | null> {
    const dbUser = await this.db.query.users.findFirst({
      columns: { aiApprovalMode: true, preferredInterface: true, preferredInterfaceSelectedAt: true },
      where: eq(users.id, userId),
    });

    return dbUser
      ? {
          aiApprovalMode: dbUser.aiApprovalMode,
          preferredInterface: dbUser.preferredInterface,
          preferredInterfaceSelectedAt: dbUser.preferredInterfaceSelectedAt?.toISOString() ?? null,
        }
      : null;
  }

  async updateUserPreferences(
    userId: string,
    input: { aiApprovalMode?: AIApprovalMode; preferredInterface?: 'ai_workspace' | 'operations_console' }
  ): Promise<{
    aiApprovalMode: AIApprovalMode;
    preferredInterface: 'ai_workspace' | 'operations_console' | null;
    preferredInterfaceSelectedAt: string | null;
  }> {
    const preferredInterfaceSelectedAt = input.preferredInterface === undefined ? undefined : new Date();
    const [updated] = await this.db
      .update(users)
      .set({
        ...(input.aiApprovalMode === undefined ? {} : { aiApprovalMode: input.aiApprovalMode }),
        ...(input.preferredInterface === undefined
          ? {}
          : { preferredInterface: input.preferredInterface, preferredInterfaceSelectedAt }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({
        aiApprovalMode: users.aiApprovalMode,
        preferredInterface: users.preferredInterface,
        preferredInterfaceSelectedAt: users.preferredInterfaceSelectedAt,
      });

    if (!updated) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    this.emitUser(userId, 'updated');
    return {
      ...updated,
      preferredInterfaceSelectedAt: updated.preferredInterfaceSelectedAt?.toISOString() ?? null,
    };
  }

  async listUsers(): Promise<User[]> {
    const allUsers = await this.db.query.users.findMany({
      where: isNull(users.deletedAt),
      orderBy: (users, { asc }) => [asc(users.sortOrder), asc(users.createdAt)],
    });

    const groupMap = await fetchGroupScopeMap(this.db);

    return allUsers.map((u) => {
      const effective = computeEffectiveUserAccess(u.groupId, groupMap, u.additionalScopes, u.additionalGroupIds);
      return {
        id: u.id,
        oidcSubject: u.oidcSubject,
        authMethod: u.authMethod,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatarUrl,
        groupId: u.groupId,
        groupName: effective.groupName,
        groupIds: effective.groupIds,
        groupNames: effective.groupNames,
        require2fa: effective.require2fa,
        groupScopes: effective.groupScopes,
        additionalScopes: effective.additionalScopes,
        scopes: effective.scopes,
        isBlocked: u.isBlocked,
        blockedBy: u.isBlocked ? (u.blockedBy ?? 'admin') : null,
        isDeleted: false,
        aiApprovalMode: u.aiApprovalMode,
        folderId: u.folderId,
        sortOrder: u.sortOrder,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        invitationSentAt: u.invitationSentAt?.toISOString() ?? null,
      };
    });
  }

  async updateUserGroup(userId: string, requestedGroups: string | string[]): Promise<User> {
    const groupIds = [...new Set(typeof requestedGroups === 'string' ? [requestedGroups] : requestedGroups)];
    if (groupIds.length === 0) throw new AppError(400, 'GROUP_REQUIRED', 'Select at least one group');
    const groupId = groupIds[0];
    const groupMap = await fetchGroupScopeMap(this.db);
    if (groupIds.some((id) => !groupMap.has(id)))
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    const [group, currentUser] = await Promise.all([
      this.db.query.permissionGroups.findFirst({
        where: eq(permissionGroups.id, groupId),
      }),
      this.db.query.users.findFirst({
        columns: { groupId: true, additionalGroupIds: true, authMethod: true },
        where: and(eq(users.id, userId), isNull(users.deletedAt)),
      }),
    ]);
    if (!group) {
      throw new Error('Permission group not found');
    }
    if (!currentUser) {
      throw new Error('User not found');
    }

    const require2fa = groupsRequireMfa(groupIds, groupMap);
    const previouslyRequired = groupsRequireMfa(
      userGroupIds(currentUser.groupId, currentUser.additionalGroupIds),
      groupMap
    );
    const mfaPolicyChanged = currentUser.authMethod !== 'oidc' && previouslyRequired !== require2fa;

    if (mfaPolicyChanged && require2fa) {
      const { mfaExistingSessionGracePeriodDays } = await this.authSettingsService.getConfig();
      const gracePeriodDays =
        Number.isInteger(mfaExistingSessionGracePeriodDays) &&
        mfaExistingSessionGracePeriodDays >= 0 &&
        mfaExistingSessionGracePeriodDays <= 7
          ? mfaExistingSessionGracePeriodDays
          : 0;
      await this.sessionService.setUserSessionsMfaGraceExpiresAt(
        userId,
        Date.now() + gracePeriodDays * MILLISECONDS_PER_DAY
      );
    }

    const [updatedUser] = await this.db.transaction(async (tx) => {
      const assignedGroups = await tx
        .select({ id: permissionGroups.id })
        .from(permissionGroups)
        .where(inArray(permissionGroups.id, groupIds))
        .orderBy(permissionGroups.id)
        .for('key share');
      if (assignedGroups.length !== groupIds.length)
        throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
      await this.assertSystemAdminRemains(tx, userId, 'demote', groupIds);
      return tx
        .update(users)
        .set({ groupId, additionalGroupIds: groupIds.slice(1), updatedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .returning();
    });

    if (!updatedUser) {
      throw new Error('User not found');
    }

    if (mfaPolicyChanged && !require2fa) {
      await this.sessionService.clearUserSessionsMfaGraceExpiresAt(userId);
    }

    const mapped = await this.mapDbUserToUser(updatedUser);
    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, mapped.isBlocked ? [] : mapped.scopes, groupId);
    if (mfaPolicyChanged) {
      this.eventBus?.publish(mfaRequiredChannel(userId), {
        groupId: group.id,
        groupName: group.name,
        require2fa,
      });
    }
    return mapped;
  }

  async assertCanUpdateUserAdditionalScopes(
    actorUserId: string,
    actorScopes: string[],
    userId: string,
    requestedScopes: string[]
  ): Promise<{ targetUser: User; additionalScopes: string[] }> {
    if (userId === actorUserId) {
      throw new AppError(400, 'SELF_PERMISSION_CHANGE', 'Cannot change your own additional permissions');
    }

    const targetUser = await this.getUserById(userId);
    if (!targetUser) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }
    if (targetUser.isDeleted) {
      throw new AppError(409, 'USER_DELETED', 'Deleted users must be restored before they can be changed');
    }
    if (targetUser.oidcSubject?.startsWith(SYSTEM_SUBJECT_PREFIX)) {
      throw new AppError(403, 'SYSTEM_USER', 'Cannot modify the system user');
    }

    const denyReason = canManageUser(actorScopes, targetUser.scopes);
    if (denyReason) {
      throw new AppError(403, 'PRIVILEGE_BOUNDARY', denyReason);
    }

    const trimmedScopes = requestedScopes.map((scope) => scope.trim());
    const invalidScopes = trimmedScopes.filter((scope) => !isValidInboundScope(scope));
    if (invalidScopes.length > 0) {
      throw new AppError(400, 'INVALID_SCOPE', `Invalid permission scopes: ${[...new Set(invalidScopes)].join(', ')}`);
    }

    // Retired scope names from older clients are rewritten to the current catalog.
    const additionalScopes = canonicalizeInboundScopes(trimmedScopes);
    if (trimmedScopes.length > 0 && additionalScopes.length === 0) {
      throw new AppError(400, 'INVALID_SCOPE', 'None of the requested permission scopes exist any more');
    }
    if (additionalScopes.includes('admin:system')) {
      throw new AppError(403, 'SCOPE_NOT_ALLOWED', 'admin:system cannot be assigned as an additional permission');
    }
    if (!isScopeSubset(additionalScopes, actorScopes)) {
      const disallowedScopes = additionalScopes.filter((scope) => !isScopeSubset([scope], actorScopes));
      throw new AppError(
        403,
        'PRIVILEGE_BOUNDARY',
        `Cannot grant permissions you do not possess: ${disallowedScopes.join(', ')}`
      );
    }

    const effectiveScopes = canonicalizeScopes([...(targetUser.groupScopes ?? []), ...additionalScopes]);
    if (!isScopeSubset(effectiveScopes, actorScopes)) {
      throw new AppError(403, 'PRIVILEGE_BOUNDARY', 'Cannot manage the resulting user permissions');
    }

    return { targetUser, additionalScopes };
  }

  async updateUserAdditionalScopes(userId: string, additionalScopes: string[]): Promise<User> {
    const [updatedUser] = await this.db
      .update(users)
      .set({ additionalScopes: canonicalizeScopes(additionalScopes), updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();

    if (!updatedUser) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    const mapped = await this.mapDbUserToUser(updatedUser);
    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, mapped.isBlocked ? [] : mapped.scopes, mapped.groupId);
    return mapped;
  }

  async assertCanUpdateUserGroup(
    actorUserId: string,
    actorScopes: string[],
    userId: string,
    requestedGroups: string | string[]
  ): Promise<User> {
    if (userId === actorUserId) {
      throw new AppError(400, 'SELF_DEMOTION', 'Cannot change your own group');
    }

    const targetUser = await this.getUserById(userId);
    if (!targetUser) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }
    if (targetUser.isDeleted) {
      throw new AppError(409, 'USER_DELETED', 'Deleted users must be restored before they can be changed');
    }

    if (targetUser.oidcSubject?.startsWith('system:')) {
      throw new AppError(403, 'SYSTEM_USER', 'Cannot modify the system user');
    }

    const denyReason = canManageUser(actorScopes, targetUser.scopes);
    if (denyReason) {
      throw new AppError(403, 'PRIVILEGE_BOUNDARY', denyReason);
    }

    const groupMap = await fetchGroupScopeMap(this.db);
    const groupIds = [...new Set(typeof requestedGroups === 'string' ? [requestedGroups] : requestedGroups)];
    if (!groupIds.length) throw new AppError(400, 'GROUP_REQUIRED', 'Select at least one group');
    if (groupIds.some((id) => !groupMap.has(id))) {
      throw new AppError(404, 'NOT_FOUND', 'Permission group not found');
    }

    const destScopes = groupIds.flatMap((id) => computeEffectiveGroupAccess(id, groupMap).scopes);
    if (!isScopeSubset(destScopes, actorScopes)) {
      throw new AppError(403, 'PRIVILEGE_BOUNDARY', 'Cannot assign a group with permissions you do not possess');
    }

    return targetUser;
  }

  /**
   * Refuse a block, delete or group change that would leave no active system
   * administrator. Runs in the caller's transaction under one advisory lock, so
   * two administrators removing each other at the same moment cannot both pass
   * (each would otherwise still count the other).
   */
  private async assertSystemAdminRemains(
    tx: DrizzleTransaction,
    targetUserId: string,
    action: 'block' | 'delete' | 'demote',
    nextGroupIds?: readonly string[]
  ): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SYSTEM_ADMINS_LOCK}))`);
    const activeAdmins = await tx
      .select({ id: users.id, adminGroupId: permissionGroups.id })
      .from(users)
      .innerJoin(permissionGroups, eq(permissionGroups.name, 'system-admin'))
      .where(
        and(
          isNull(users.deletedAt),
          eq(users.isBlocked, false),
          // The built-in system account cannot sign in, so it does not count.
          or(isNull(users.oidcSubject), notLike(users.oidcSubject, `${SYSTEM_SUBJECT_PREFIX}%`)),
          or(eq(users.groupId, permissionGroups.id), sql`${permissionGroups.id} = any(${users.additionalGroupIds})`)
        )
      );
    if (!activeAdmins.some((admin) => admin.id === targetUserId)) return;
    if (nextGroupIds?.includes(activeAdmins[0]!.adminGroupId)) return;
    if (activeAdmins.some((admin) => admin.id !== targetUserId)) return;
    const verb = action === 'block' ? 'block' : action === 'delete' ? 'delete' : 'remove from the system-admin group';
    throw new AppError(
      409,
      'LAST_SYSTEM_ADMIN',
      `Cannot ${verb} the last active system administrator; promote or unblock another administrator first`
    );
  }

  async blockUser(userId: string): Promise<User> {
    const [updatedUser] = await this.db.transaction(async (tx) => {
      await this.assertSystemAdminRemains(tx, userId, 'block');
      // An administrator's block, also over a block of the Opfield account: only an administrator lifts it.
      return tx
        .update(users)
        .set({ isBlocked: true, blockedBy: 'admin', updatedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .returning();
    });

    if (!updatedUser) {
      throw new Error('User not found');
    }

    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, [], null, 'user_blocked');
    return this.mapDbUserToUser(updatedUser);
  }

  /**
   * The Opfield account removed this person's access (sso-revoke): the account is blocked as the Opfield account's,
   * which the next sign-in through the same issuer lifts. Unlike an administrator's block, the browser sessions end, so
   * that sign-in is the way back. Tokens are kept and refused while blocked. Null when the account was already
   * blocked (by either) or is deleted: nothing changed. Refused with LAST_SYSTEM_ADMIN like any block.
   */
  async blockUserForOpfieldAccount(userId: string): Promise<User | null> {
    const [updatedUser] = await this.db.transaction(async (tx) => {
      await this.assertSystemAdminRemains(tx, userId, 'block');
      return tx
        .update(users)
        .set({ isBlocked: true, blockedBy: 'opfield_account', updatedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.deletedAt), eq(users.isBlocked, false)))
        .returning();
    });
    if (!updatedUser) return null;

    await this.sessionService.destroyAllUserSessions(userId);
    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, [], null, 'user_blocked');
    return this.mapDbUserToUser(updatedUser);
  }

  async unblockUser(userId: string): Promise<User> {
    const [updatedUser] = await this.db
      .update(users)
      // Lifts either block: an administrator's, or the Opfield account's.
      .set({ isBlocked: false, blockedBy: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();

    if (!updatedUser) {
      throw new Error('User not found');
    }

    const mapped = await this.mapDbUserToUser(updatedUser);
    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, mapped.scopes, mapped.groupId ?? null);
    return mapped;
  }

  async deleteUser(userId: string, deletedByUserId: string): Promise<void> {
    const target = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (target.deletedAt) throw new AppError(409, 'USER_DELETED', 'User is already deleted');

    const systemAdminGroup = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.name, 'system-admin'),
    });
    if (!systemAdminGroup) throw new Error('System administrator group not found');

    const deletedAt = new Date();
    const [deleted] = await this.db.transaction(async (tx) => {
      await this.assertSystemAdminRemains(tx, userId, 'delete');
      return tx
        .update(users)
        .set({
          isBlocked: true,
          blockedBy: 'admin',
          deletedAt,
          deletedByUserId,
          deletedFromGroupId: target.groupId,
          deletedFromAdditionalGroupIds: target.additionalGroupIds ?? [],
          additionalGroupIds: [],
          groupId: systemAdminGroup.id,
          updatedAt: deletedAt,
        })
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .returning({ id: users.id });
    });
    if (!deleted) throw new AppError(409, 'USER_DELETED', 'User is already deleted');

    await this.sessionService.destroyAllUserSessions(userId);
    await Promise.all([
      this.db.delete(apiTokens).where(eq(apiTokens.userId, userId)),
      this.db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, userId)),
      this.db.update(oauthAccessTokens).set({ revokedAt: deletedAt }).where(eq(oauthAccessTokens.userId, userId)),
      this.db.update(oauthRefreshTokens).set({ revokedAt: deletedAt }).where(eq(oauthRefreshTokens.userId, userId)),
      this.db.update(inferenceTokens).set({ revokedAt: deletedAt }).where(eq(inferenceTokens.userId, userId)),
      this.db.delete(gitLabUserCredentials).where(eq(gitLabUserCredentials.userId, userId)),
      this.db.delete(inferenceOAuthSessions).where(eq(inferenceOAuthSessions.userId, userId)),
    ]);

    logger.info('User soft-deleted', { userId, deletedByUserId });
    this.emitUser(userId, 'deleted');
    this.emitPermissions(userId, [], null, 'user_deleted');
  }

  async listDeletedUsers(): Promise<DeletedUser[]> {
    const deletedUsers = await this.db.query.users.findMany({
      where: isNotNull(users.deletedAt),
      orderBy: (users, { desc }) => [desc(users.deletedAt)],
    });
    const groupMap = await fetchGroupScopeMap(this.db);

    return deletedUsers.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      deletedAt: user.deletedAt!.toISOString(),
      deletedByUserId: user.deletedByUserId,
      deletedFromGroupId: user.deletedFromGroupId,
      originalGroupExists: Boolean(user.deletedFromGroupId && groupMap.has(user.deletedFromGroupId)),
    }));
  }

  /**
   * `grantableScopes`, when given, bounds the permissions the restored account receives: the caller
   * cannot restore someone into groups with permissions it does not hold.
   */
  async restoreUser(userId: string, requestedGroups?: string | string[], grantableScopes?: string[]): Promise<User> {
    const requestedGroupIds = typeof requestedGroups === 'string' ? [requestedGroups] : requestedGroups;
    if (requestedGroupIds?.length === 0) throw new AppError(400, 'GROUP_REQUIRED', 'Select at least one group');
    const requestedGroupId = requestedGroupIds?.[0];
    const deletedUser = await this.db.query.users.findFirst({
      where: and(eq(users.id, userId), isNotNull(users.deletedAt)),
    });
    if (!deletedUser) throw new AppError(404, 'USER_NOT_FOUND', 'Deleted user not found');

    const groupId = requestedGroupId ?? deletedUser.deletedFromGroupId;
    if (!groupId) {
      throw new AppError(409, 'RESTORE_GROUP_REQUIRED', 'Choose a permission group before restoring this user');
    }
    const group = await this.db.query.permissionGroups.findFirst({ where: eq(permissionGroups.id, groupId) });
    if (!group) {
      if (!requestedGroupId) {
        throw new AppError(409, 'RESTORE_GROUP_REQUIRED', 'The original permission group no longer exists');
      }
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    }

    const restore = async (executor: DrizzleExecutor) => {
      const groupMap = await fetchGroupScopeMap(this.db);
      const additionalGroupIds = requestedGroupIds
        ? [...new Set(requestedGroupIds)].slice(1)
        : (deletedUser.deletedFromAdditionalGroupIds ?? []).filter((id) => id !== group.id && groupMap.has(id));
      const groupIds = userGroupIds(group.id, additionalGroupIds);
      if (grantableScopes) {
        const restoredScopes = groupIds.flatMap((id) => computeEffectiveGroupAccess(id, groupMap).scopes);
        if (!isScopeSubset(restoredScopes, grantableScopes)) {
          throw new AppError(
            403,
            'PRIVILEGE_BOUNDARY',
            'Cannot restore a user into groups with permissions you do not possess'
          );
        }
      }
      const assignedGroups = await executor
        .select({ id: permissionGroups.id })
        .from(permissionGroups)
        .where(inArray(permissionGroups.id, groupIds))
        .orderBy(permissionGroups.id)
        .for('key share');
      if (assignedGroups.length !== groupIds.length)
        throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
      const [restored] = await executor
        .update(users)
        .set({
          groupId: group.id,
          additionalGroupIds,
          isBlocked: true,
          blockedBy: 'admin',
          deletedAt: null,
          deletedByUserId: null,
          deletedFromGroupId: null,
          deletedFromAdditionalGroupIds: [],
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, userId), isNotNull(users.deletedAt)))
        .returning();
      return restored;
    };
    const restored = await requireConfiguredLicenseQuota(this.licenseQuota).run(
      'users',
      (tx) => this.countActiveUsers(tx),
      restore
    );
    if (!restored) throw new AppError(404, 'USER_NOT_FOUND', 'Deleted user not found');

    const mapped = await this.mapDbUserToUser(restored);
    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, [], group.id, 'user_restored');
    return mapped;
  }

  async validateSession(sessionId: string): Promise<User | null> {
    return this.sessionService.validateSession(sessionId);
  }

  private async countActiveUsers(executor: DrizzleExecutor): Promise<number> {
    const [result] = await executor
      .select({ count: count() })
      .from(users)
      .where(and(isNull(users.deletedAt), ne(users.id, OPFIELD_SYSTEM_USER_ID)));
    return Number(result?.count ?? 0);
  }
}
