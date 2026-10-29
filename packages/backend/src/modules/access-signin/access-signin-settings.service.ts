import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import { scheduleAccessPolicySync } from './access-policy-sync.js';
import {
  type AccessSignInSettingsUpdate,
  DEFAULT_ACCESS_SESSION_TTL_SECONDS,
  MAX_ACCESS_SESSION_TTL_SECONDS,
  MIN_ACCESS_SESSION_TTL_SECONDS,
} from './access-signin.schemas.js';
import { normalizeAccessHost } from './access-token.js';

export const ACCESS_SIGN_IN_SETTINGS_KEY = 'access.signIn';
const CACHE_MS = 5_000;

export interface AccessSignInSettings {
  /** Null: the Opfield public URL host serves the sign-in pages. */
  domain: string | null;
  defaultSessionTtlSeconds: number;
  /** Placement of the sign-in system route; both null: no route (the domain reaches Opfield another way). */
  nodeId: string | null;
  ingressGroupId: string | null;
  sslCertificateId: string | null;
}

export interface AccessSignInSettingsView extends AccessSignInSettings {
  /** Origin visitors are sent to, e.g. https://access.example.com. */
  signInOrigin: string;
}

const DEFAULT_SETTINGS: AccessSignInSettings = {
  domain: null,
  defaultSessionTtlSeconds: DEFAULT_ACCESS_SESSION_TTL_SECONDS,
  nodeId: null,
  ingressGroupId: null,
  sslCertificateId: null,
};

type SystemHostRuntime = Pick<
  ProxyService,
  'upsertBackendSystemHost' | 'disableBackendSystemHost' | 'assertSystemHostPlacementAccess'
>;

function normalize(value: unknown): AccessSignInSettings {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const text = (field: string) =>
    typeof record[field] === 'string' && (record[field] as string).trim() ? (record[field] as string).trim() : null;
  const ttl = Number(record.defaultSessionTtlSeconds);
  return {
    domain: text('domain')?.toLowerCase() ?? null,
    defaultSessionTtlSeconds:
      Number.isInteger(ttl) && ttl >= MIN_ACCESS_SESSION_TTL_SECONDS && ttl <= MAX_ACCESS_SESSION_TTL_SECONDS
        ? ttl
        : DEFAULT_ACCESS_SESSION_TTL_SECONDS,
    nodeId: text('nodeId'),
    ingressGroupId: text('ingressGroupId'),
    sslCertificateId: text('sslCertificateId'),
  };
}

/** Setting `access.signIn`: the sign-in domain, its system route and the default session length. */
export class AccessSignInSettingsService {
  private cached: { value: AccessSignInSettings; at: number } | null = null;
  private systemHosts?: SystemHostRuntime;

  constructor(
    private readonly db: DrizzleClient,
    private readonly publicUrl: () => Promise<string | null>,
    private readonly auditService?: Pick<AuditService, 'log'>
  ) {}

  setSystemHostRuntime(runtime: SystemHostRuntime): void {
    this.systemHosts = runtime;
  }

  async getConfig(): Promise<AccessSignInSettings> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, ACCESS_SIGN_IN_SETTINGS_KEY))
      .limit(1);
    const value = row ? normalize(row.value) : { ...DEFAULT_SETTINGS };
    this.cached = { value, at: Date.now() };
    return value;
  }

  async getView(): Promise<AccessSignInSettingsView> {
    const config = await this.getConfig();
    return { ...config, signInOrigin: await this.signInOrigin(config) };
  }

  /** Origin of the sign-in pages: the sign-in domain, else the Opfield public URL. */
  async signInOrigin(config?: AccessSignInSettings): Promise<string> {
    const current = config ?? (await this.getConfig());
    if (current.domain) {
      // A route Opfield places without a certificate serves plain HTTP; anything else is expected to be HTTPS.
      const placed = !!(current.nodeId || current.ingressGroupId);
      return `${placed && !current.sslCertificateId ? 'http' : 'https'}://${current.domain}`;
    }
    const publicUrl = await this.publicUrl();
    if (!publicUrl) throw new AppError(503, 'ACCESS_SIGN_IN_UNAVAILABLE', 'Opfield has no public URL yet');
    return new URL(publicUrl).origin;
  }

  /** The host the sign-in pages are served on (aud of the central session cookie). */
  async signInHost(): Promise<string> {
    return normalizeAccessHost(new URL(await this.signInOrigin()).host);
  }

  /** Whether a request host is the dedicated sign-in domain (not the console host). */
  async isSignInDomainHost(hostHeader: string | undefined): Promise<boolean> {
    const host = normalizeAccessHost(hostHeader);
    if (!host) return false;
    const { domain } = await this.getConfig();
    return !!domain && domain === host;
  }

  async update(
    input: AccessSignInSettingsUpdate,
    actor: { userId: string; scopes: readonly string[] }
  ): Promise<AccessSignInSettingsView> {
    const current = await this.getConfig();
    const next: AccessSignInSettings = {
      domain: input.domain === undefined ? current.domain : (input.domain ?? null),
      defaultSessionTtlSeconds: input.defaultSessionTtlSeconds ?? current.defaultSessionTtlSeconds,
      nodeId: input.nodeId === undefined ? current.nodeId : (input.nodeId ?? null),
      ingressGroupId: input.ingressGroupId === undefined ? current.ingressGroupId : (input.ingressGroupId ?? null),
      sslCertificateId:
        input.sslCertificateId === undefined ? current.sslCertificateId : (input.sslCertificateId ?? null),
    };
    if (!next.domain) {
      next.nodeId = null;
      next.ingressGroupId = null;
      next.sslCertificateId = null;
    }
    if (next.ingressGroupId) next.nodeId = null;
    if (next.domain) {
      const publicUrl = await this.publicUrl();
      if (publicUrl && normalizeAccessHost(new URL(publicUrl).host) === next.domain) {
        throw new AppError(
          400,
          'ACCESS_SIGN_IN_DOMAIN_IS_CONSOLE',
          'The sign-in domain must differ from the Opfield public URL; clear it to sign in on the Opfield host'
        );
      }
    }

    await this.applySystemRoute(next, current, actor);
    await this.db
      .insert(settings)
      .values({ key: ACCESS_SIGN_IN_SETTINGS_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
    this.cached = { value: next, at: Date.now() };
    await this.auditService?.log({
      userId: actor.userId,
      action: 'access_sign_in.settings_update',
      resourceType: 'settings',
      resourceId: ACCESS_SIGN_IN_SETTINGS_KEY,
      details: { domain: next.domain, defaultSessionTtlSeconds: next.defaultSessionTtlSeconds },
    });
    // The sign-in origin is part of the policy every ingress node redirects with.
    scheduleAccessPolicySync();
    return { ...next, signInOrigin: await this.signInOrigin(next) };
  }

  private async applySystemRoute(
    next: AccessSignInSettings,
    current: AccessSignInSettings,
    actor: { userId: string; scopes: readonly string[] }
  ): Promise<void> {
    const placed = !!next.domain && !!(next.nodeId || next.ingressGroupId);
    const wasPlaced = !!current.domain && !!(current.nodeId || current.ingressGroupId);
    if (!placed) {
      if (wasPlaced) await this.systemHosts?.disableBackendSystemHost('access_sign_in', actor.userId);
      return;
    }
    if (!this.systemHosts) {
      throw new AppError(503, 'ACCESS_SIGN_IN_UNAVAILABLE', 'Routes are not available');
    }
    const unchanged =
      wasPlaced &&
      current.domain === next.domain &&
      current.nodeId === next.nodeId &&
      current.ingressGroupId === next.ingressGroupId &&
      current.sslCertificateId === next.sslCertificateId;
    if (unchanged) return;
    const placementChanged = current.nodeId !== next.nodeId || current.ingressGroupId !== next.ingressGroupId;
    if (placementChanged) {
      await this.systemHosts.assertSystemHostPlacementAccess(actor.scopes, {
        nodeId: next.nodeId,
        ingressGroupId: next.ingressGroupId,
      });
    }
    await this.systemHosts.upsertBackendSystemHost(
      'access_sign_in',
      {
        domain: next.domain!,
        // With an ingress group the group's first member is recorded.
        nodeId: next.nodeId ?? '',
        ingressGroupId: next.ingressGroupId,
        sslCertificateId: next.sslCertificateId,
      },
      actor.userId
    );
  }
}
