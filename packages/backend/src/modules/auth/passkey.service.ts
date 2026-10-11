import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, eq, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { getEnv } from '@/config/env.js';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { permissionGroups, userPasskeys, users, userTotpFactors } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { User } from '@/types.js';
import type { AuthSettingsService } from './auth.settings.service.js';

const PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60;

interface PasskeyChallenge {
  challenge: string;
  userId?: string;
}

@injectable()
export class PasskeyService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly cacheService: CacheService,
    private readonly authSettingsService: AuthSettingsService,
    private readonly generalSettingsService?: GeneralSettingsService
  ) {}

  async listPasskeys(userId: string) {
    return this.db
      .select({
        id: userPasskeys.id,
        name: userPasskeys.name,
        lastUsedAt: userPasskeys.lastUsedAt,
        createdAt: userPasskeys.createdAt,
      })
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, userId));
  }

  async beginRegistration(user: User) {
    this.assertLocalUser(user);
    const existing = await this.db
      .select({ credentialId: userPasskeys.credentialId, transports: userPasskeys.transports })
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, user.id));
    const options = await generateRegistrationOptions({
      rpName: 'Opfield',
      rpID: this.rpId(),
      userName: user.email,
      userID: new TextEncoder().encode(user.id),
      userDisplayName: user.name ?? user.email,
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: asTransports(credential.transports),
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    await this.cacheService.set<PasskeyChallenge>(
      `passkey:registration:${user.id}`,
      { challenge: options.challenge, userId: user.id },
      PASSKEY_CHALLENGE_TTL_SECONDS
    );
    return options;
  }

  async finishRegistration(user: User, response: RegistrationResponseJSON, name: string): Promise<void> {
    this.assertLocalUser(user);
    const pending = await this.cacheService.get<PasskeyChallenge>(`passkey:registration:${user.id}`);
    if (!pending) throw new AppError(400, 'PASSKEY_CHALLENGE_EXPIRED', 'Passkey enrollment has expired');
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.publicUrl(),
      expectedRPID: this.rpId(),
      requireUserVerification: true,
    }).catch(() => ({ verified: false as const }));
    if (!verification.verified)
      throw new AppError(400, 'INVALID_PASSKEY', 'Passkey registration could not be verified');
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await this.db.insert(userPasskeys).values({
      userId: user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      name: name.trim() || 'Passkey',
    });
    await this.cacheService.delete(`passkey:registration:${user.id}`);
  }

  async removePasskey(userId: string, passkeyId: string): Promise<boolean> {
    const [accounts, totp] = await Promise.all([
      this.db
        .select({
          authMethod: users.authMethod,
          requireGateway2fa: sql<boolean>`${permissionGroups.requireGateway2fa} OR EXISTS (SELECT 1 FROM permission_groups g WHERE g.id = ANY(${users.additionalGroupIds}) AND g.require_gateway_2fa)`,
        })
        .from(users)
        .innerJoin(permissionGroups, eq(permissionGroups.id, users.groupId))
        .where(eq(users.id, userId))
        .limit(1),
      this.db.query.userTotpFactors.findFirst({ where: eq(userTotpFactors.userId, userId) }),
    ]);
    const account = accounts[0];
    if (account?.requireGateway2fa && account.authMethod !== 'oidc' && !totp) {
      const passkeys = await this.db
        .select({ id: userPasskeys.id })
        .from(userPasskeys)
        .where(eq(userPasskeys.userId, userId));
      if (passkeys.length <= 1) {
        throw new AppError(
          409,
          'MFA_FACTOR_REQUIRED',
          'An administrator must reset MFA before the last required factor can be removed'
        );
      }
    }
    const deleted = await this.db
      .delete(userPasskeys)
      .where(and(eq(userPasskeys.id, passkeyId), eq(userPasskeys.userId, userId)))
      .returning({ id: userPasskeys.id });
    return deleted.length === 1;
  }

  async beginDiscoverableAuthentication() {
    await this.assertPasskeysEnabled();
    const options = await generateAuthenticationOptions({ rpID: this.rpId(), userVerification: 'required' });
    await this.cacheService.set<PasskeyChallenge>(
      `passkey:authentication:${options.challenge}`,
      { challenge: options.challenge },
      PASSKEY_CHALLENGE_TTL_SECONDS
    );
    return options;
  }

  async verifyAuthentication(
    challenge: string,
    response: AuthenticationResponseJSON,
    expectedUserId?: string,
    requireDirectPasskeySignIn = true
  ): Promise<User | null> {
    if (requireDirectPasskeySignIn) await this.assertPasskeysEnabled();
    const pending = await this.cacheService.get<PasskeyChallenge>(`passkey:authentication:${challenge}`);
    if (!pending || (expectedUserId && pending.userId !== expectedUserId)) return null;
    const credential = await this.db.query.userPasskeys.findFirst({
      where: eq(userPasskeys.credentialId, response.id),
    });
    if (!credential || (expectedUserId && credential.userId !== expectedUserId)) return null;
    const user = await resolveLiveUser(this.db, credential.userId);
    if (!user || user.isBlocked || user.authMethod === 'oidc') return null;
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.publicUrl(),
        expectedRPID: this.rpId(),
        credential: {
          id: credential.credentialId,
          publicKey: Buffer.from(credential.publicKey, 'base64url'),
          counter: credential.counter,
          transports: asTransports(credential.transports),
        },
        requireUserVerification: true,
      });
    } catch {
      return null;
    }
    if (!verification.verified) return null;
    const claimed = await this.cacheService.take<PasskeyChallenge>(`passkey:authentication:${challenge}`);
    if (!claimed || claimed.challenge !== pending.challenge || claimed.userId !== pending.userId) return null;
    await this.db
      .update(userPasskeys)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(userPasskeys.id, credential.id));
    return user;
  }

  async beginAuthenticationForUser(userId: string) {
    const credentials = await this.db
      .select({ credentialId: userPasskeys.credentialId, transports: userPasskeys.transports })
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, userId));
    if (credentials.length === 0)
      throw new AppError(400, 'PASSKEY_NOT_CONFIGURED', 'No passkey is configured for this account');
    const options = await generateAuthenticationOptions({
      rpID: this.rpId(),
      userVerification: 'required',
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: asTransports(credential.transports),
      })),
    });
    await this.cacheService.set<PasskeyChallenge>(
      `passkey:authentication:${options.challenge}`,
      { challenge: options.challenge, userId },
      PASSKEY_CHALLENGE_TTL_SECONDS
    );
    return options;
  }

  private async assertPasskeysEnabled(): Promise<void> {
    if (!(await this.authSettingsService.getConfig()).methods.passkeyLogin) {
      throw new AppError(409, 'PASSKEY_DISABLED', 'Passkey sign-in is disabled');
    }
  }

  private assertLocalUser(user: User): void {
    if (user.authMethod === 'oidc')
      throw new AppError(409, 'PASSKEY_NOT_AVAILABLE', 'OIDC accounts use identity-provider authentication');
  }

  private rpId(): string {
    return new URL(this.publicUrl()).hostname;
  }

  private publicUrl(): string {
    return this.generalSettingsService?.getCachedPublicUrl() ?? getEnv().APP_URL;
  }
}

function asTransports(value: string[]): AuthenticatorTransportFuture[] {
  const allowed = new Set<AuthenticatorTransportFuture>([
    'ble',
    'cable',
    'hybrid',
    'internal',
    'nfc',
    'smart-card',
    'usb',
  ]);
  return value.filter((transport): transport is AuthenticatorTransportFuture =>
    allowed.has(transport as AuthenticatorTransportFuture)
  );
}
