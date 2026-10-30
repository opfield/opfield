import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import {
  type AccessSignInSettingsUpdate,
  DEFAULT_ACCESS_SESSION_TTL_SECONDS,
  MAX_ACCESS_SESSION_TTL_SECONDS,
  MIN_ACCESS_SESSION_TTL_SECONDS,
} from './access-signin.schemas.js';

export const ACCESS_SIGN_IN_SETTINGS_KEY = 'access.signIn';
const CACHE_MS = 5_000;

export interface AccessSignInSettings {
  defaultSessionTtlSeconds: number;
}

export type AccessSignInSettingsView = AccessSignInSettings;

const DEFAULT_SETTINGS: AccessSignInSettings = {
  defaultSessionTtlSeconds: DEFAULT_ACCESS_SESSION_TTL_SECONDS,
};

type SystemHostRuntime = Pick<ProxyService, 'disableBackendSystemHost'>;

function normalize(value: unknown): AccessSignInSettings {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const ttl = Number(record.defaultSessionTtlSeconds);
  return {
    defaultSessionTtlSeconds:
      Number.isInteger(ttl) && ttl >= MIN_ACCESS_SESSION_TTL_SECONDS && ttl <= MAX_ACCESS_SESSION_TTL_SECONDS
        ? ttl
        : DEFAULT_ACCESS_SESSION_TTL_SECONDS,
  };
}

/** Setting `access.signIn`: the default session length of access lists. */
export class AccessSignInSettingsService {
  private cached: { value: AccessSignInSettings; at: number } | null = null;
  private systemHosts?: SystemHostRuntime;

  constructor(
    private readonly db: DrizzleClient,
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
    return this.getConfig();
  }

  async update(
    input: AccessSignInSettingsUpdate,
    actor: { userId: string; scopes: readonly string[] }
  ): Promise<AccessSignInSettingsView> {
    const current = await this.getConfig();
    const next: AccessSignInSettings = {
      defaultSessionTtlSeconds: input.defaultSessionTtlSeconds ?? current.defaultSessionTtlSeconds,
    };
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
      details: { defaultSessionTtlSeconds: next.defaultSessionTtlSeconds },
    });
    return next;
  }

  /**
   * Withdraws the system route of the sign-in domain that installations before route sign-in pages placed (setting
   * access.signIn domain with a node or ingress group): its node config is removed, then the route. A node that is
   * offline keeps it until the next periodic run reaches it.
   */
  async removeLegacySystemRoute(): Promise<void> {
    await this.systemHosts?.disableBackendSystemHost('access_sign_in', null);
  }
}
