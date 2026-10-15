import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  type CloudMailLimits,
  type CloudMailMessage,
  CloudMailRefusedError,
  type CloudMailState,
  type CloudMailTransport,
  PERMANENT_CLOUD_MAIL_CODES,
} from '@/modules/auth/auth-mail-cloud.js';
import type { CloudPortalAnswer } from './cloud-link-outbound.js';
import { CLOUD_ADDON_SETTING_KEYS, readCloudSetting, writeCloudSetting } from './cloud-link-settings.js';

const logger = createChildLogger('CloudMail');

/** The cloud email the account set (mail-config), and the owner's own-SMTP choice. */
export interface StoredCloudMail {
  enabled: boolean;
  from: string | null;
  limits: CloudMailLimits | null;
  /** When the account last changed it. */
  updatedAt: string;
  /** "Use my own SMTP" in Settings → SMTP. */
  ownSmtp: boolean;
  ownSmtpChangedAt?: string;
  ownSmtpChangedBy?: string | null;
}

export type CloudMailConfigInput = { enabled: true; from: string; limits: CloudMailLimits } | { enabled: false };

export interface CloudMailDeps {
  db: DrizzleClient;
  managedByCloud: () => Promise<boolean>;
  /** Sends the account a request over the link (CloudLinkAgent.request). */
  request: (type: string, params: Record<string, unknown>) => Promise<CloudPortalAnswer>;
  /** The transport in use may have changed: the hello (which reports it) goes out again. */
  transportChanged?: () => void;
}

/**
 * Opfield Cloud email of a managed installation: the account says which address it sends from and its limits
 * (mail-config); sign-in emails then go to the account over the link as a `mail` request, the account renders and
 * sends them. The owner can switch to their own SMTP and back.
 */
export class CloudMail implements CloudMailTransport {
  constructor(private readonly deps: CloudMailDeps) {}

  private read(): Promise<StoredCloudMail | null> {
    return readCloudSetting<StoredCloudMail>(this.deps.db, CLOUD_ADDON_SETTING_KEYS.mail);
  }

  /** For the hello of a managed installation: the transport in use; null when not managed. */
  async helloTransport(): Promise<'cloud' | 'smtp' | null> {
    if (!(await this.deps.managedByCloud())) return null;
    return (await this.state()).active ? 'cloud' : 'smtp';
  }

  async state(): Promise<CloudMailState> {
    const stored = await this.read();
    const available = Boolean(stored?.enabled && stored.from) && (await this.deps.managedByCloud());
    const ownSmtp = stored?.ownSmtp === true;
    return {
      available,
      active: available && !ownSmtp,
      ownSmtp,
      from: available ? (stored?.from ?? null) : null,
      limits: available ? (stored?.limits ?? null) : null,
      since: available ? (stored?.updatedAt ?? null) : null,
    };
  }

  /** mail-config: stores what the account set (idempotent) and answers the transport in use. */
  async configure(input: CloudMailConfigInput): Promise<{ transport: 'cloud' | 'smtp' }> {
    const stored = await this.read();
    const next: StoredCloudMail = input.enabled
      ? {
          ...stored,
          enabled: true,
          from: input.from,
          limits: input.limits,
          updatedAt: stored?.enabled && stored.from === input.from ? stored.updatedAt : new Date().toISOString(),
          ownSmtp: stored?.ownSmtp === true,
        }
      : {
          ...stored,
          enabled: false,
          from: null,
          limits: null,
          updatedAt: new Date().toISOString(),
          ownSmtp: stored?.ownSmtp === true,
        };
    const changed =
      !stored ||
      stored.enabled !== next.enabled ||
      stored.from !== next.from ||
      JSON.stringify(stored.limits) !== JSON.stringify(next.limits);
    if (changed) {
      await writeCloudSetting(this.deps.db, CLOUD_ADDON_SETTING_KEYS.mail, next);
      // The request itself is audited (cloud.request); the owner's switch with the settings update.
      logger.info('Opfield Cloud email set by the account', { enabled: next.enabled, from: next.from });
      this.deps.transportChanged?.();
    }
    return { transport: (await this.state()).active ? 'cloud' : 'smtp' };
  }

  async setOwnSmtp(own: boolean, userId: string | null): Promise<CloudMailState> {
    const stored = await this.read();
    if (!stored) throw new Error('Opfield Cloud email is not set up on this installation');
    if (stored.ownSmtp !== own) {
      await writeCloudSetting(this.deps.db, CLOUD_ADDON_SETTING_KEYS.mail, {
        ...stored,
        ownSmtp: own,
        ownSmtpChangedAt: new Date().toISOString(),
        ownSmtpChangedBy: userId,
      } satisfies StoredCloudMail);
      // The account sees the switch at once, not at the next mail-config.
      this.deps.transportChanged?.();
    }
    return this.state();
  }

  async send(message: CloudMailMessage): Promise<void> {
    const answer = await this.deps.request('mail', { ...message });
    if (answer.ok) return;
    if (answer.code && (PERMANENT_CLOUD_MAIL_CODES as readonly string[]).includes(answer.code)) {
      throw new CloudMailRefusedError(answer.code, answer.error, answer.retryAt ?? null);
    }
    // MAIL_UNAVAILABLE and anything else: worth another attempt.
    throw new Error(answer.code ? `${answer.code}: ${answer.error}` : answer.error);
  }
}
