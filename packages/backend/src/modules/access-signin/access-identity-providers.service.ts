import { arrayContains, asc, eq } from 'drizzle-orm';
import * as client from 'openid-client';
import type { DrizzleClient } from '@/db/client.js';
import { accessIdentityProviders, accessLists } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { CreateAccessIdentityProviderInput, UpdateAccessIdentityProviderInput } from './access-signin.schemas.js';

const logger = createChildLogger('AccessIdentityProviders');
export const GOOGLE_ISSUER = 'https://accounts.google.com';

export type AccessIdentityProviderRow = typeof accessIdentityProviders.$inferSelect;

/**
 * The redirect URI to register at a provider: every protected route signs in on its own page, so each route's address
 * is registered (https://<route host>/_opfield/access/provider-callback).
 */
export const IDENTITY_PROVIDER_REDIRECT_URI_PATTERN = 'https://<route host>/_opfield/access/provider-callback';

/**
 * Google and OIDC providers access lists offer as sign-in methods (`idp:<id>`). The client secret is stored encrypted
 * and never returned.
 */
export class AccessIdentityProviderService {
  private readonly discovered = new Map<string, { key: string; config: client.Configuration }>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: Pick<CryptoService, 'encryptString' | 'decryptString'>,
    private readonly auditService?: Pick<AuditService, 'log'>
  ) {}

  async list() {
    const rows = await this.db.select().from(accessIdentityProviders).orderBy(asc(accessIdentityProviders.name));
    return rows.map((row) => this.toView(row));
  }

  async get(id: string) {
    return this.toView(await this.require(id));
  }

  async find(id: string): Promise<AccessIdentityProviderRow | null> {
    const [row] = await this.db
      .select()
      .from(accessIdentityProviders)
      .where(eq(accessIdentityProviders.id, id))
      .limit(1);
    return row ?? null;
  }

  async create(input: CreateAccessIdentityProviderInput, userId: string | null) {
    const [row] = await this.db
      .insert(accessIdentityProviders)
      .values({
        ...(input.id ? { id: input.id } : {}),
        kind: input.kind,
        name: input.name,
        issuer: input.kind === 'google' ? GOOGLE_ISSUER : input.issuer!,
        clientId: input.clientId,
        encryptedClientSecret: this.encryptSecret(input.clientSecret),
        scopes: input.scopes ?? 'openid email profile',
        groupsClaim: input.groupsClaim?.trim() || null,
      })
      .returning();
    await this.audit(userId, 'access_identity_provider.create', row);
    return this.toView(row);
  }

  async update(id: string, input: UpdateAccessIdentityProviderInput, userId: string | null) {
    const existing = await this.require(id);
    const [row] = await this.db
      .update(accessIdentityProviders)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.issuer === undefined || existing.kind === 'google' ? {} : { issuer: input.issuer }),
        ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
        ...(input.clientSecret === undefined ? {} : { encryptedClientSecret: this.encryptSecret(input.clientSecret) }),
        ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
        ...(input.groupsClaim === undefined ? {} : { groupsClaim: input.groupsClaim?.trim() || null }),
        updatedAt: new Date(),
      })
      .where(eq(accessIdentityProviders.id, id))
      .returning();
    this.discovered.delete(id);
    await this.audit(userId, 'access_identity_provider.update', row);
    return this.toView(row);
  }

  /** Refused while an access list offers the provider: remove the method from those lists first. */
  async delete(id: string, userId: string | null): Promise<void> {
    const existing = await this.require(id);
    const users = await this.db
      .select({ id: accessLists.id, name: accessLists.name })
      .from(accessLists)
      .where(arrayContains(accessLists.signInMethods, [`idp:${id}`]));
    if (users.length > 0) {
      throw new AppError(
        409,
        'ACCESS_IDENTITY_PROVIDER_IN_USE',
        `Access lists offer this provider: ${users.map((list) => list.name).join(', ')}. Remove it from them first.`,
        { accessListIds: users.map((list) => list.id) }
      );
    }
    await this.db.delete(accessIdentityProviders).where(eq(accessIdentityProviders.id, id));
    this.discovered.delete(id);
    await this.audit(userId, 'access_identity_provider.delete', existing);
  }

  /** The provider's OpenID configuration (discovery from its issuer), cached until the provider changes. */
  async clientConfiguration(provider: AccessIdentityProviderRow): Promise<client.Configuration> {
    const secret = this.decryptSecret(provider.encryptedClientSecret);
    const key = JSON.stringify([provider.issuer, provider.clientId, secret]);
    const cached = this.discovered.get(provider.id);
    if (cached?.key === key) return cached.config;
    try {
      const config = await client.discovery(new URL(provider.issuer), provider.clientId, secret);
      this.discovered.set(provider.id, { key, config });
      return config;
    } catch (error) {
      logger.warn('Identity provider discovery failed', {
        providerId: provider.id,
        issuer: provider.issuer,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(502, 'ACCESS_IDENTITY_PROVIDER_UNAVAILABLE', `${provider.name} cannot be reached right now`);
    }
  }

  private toView(row: AccessIdentityProviderRow) {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      issuer: row.issuer,
      clientId: row.clientId,
      scopes: row.scopes,
      groupsClaim: row.groupsClaim,
      // Register this at the provider, with the host of every route whose list offers it.
      redirectUri: IDENTITY_PROVIDER_REDIRECT_URI_PATTERN,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async require(id: string): Promise<AccessIdentityProviderRow> {
    const row = await this.find(id);
    if (!row) throw new AppError(404, 'ACCESS_IDENTITY_PROVIDER_NOT_FOUND', 'Identity provider not found');
    return row;
  }

  private encryptSecret(secret: string): string {
    return JSON.stringify(this.cryptoService.encryptString(secret));
  }

  private decryptSecret(stored: string): string {
    return this.cryptoService.decryptString(JSON.parse(stored));
  }

  private async audit(userId: string | null, action: string, row: AccessIdentityProviderRow) {
    await this.auditService?.log({
      userId,
      action,
      resourceType: 'access_identity_provider',
      resourceId: row.id,
      details: { kind: row.kind, name: row.name, issuer: row.issuer },
    });
  }
}
