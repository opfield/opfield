import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { type AuthEmailInput, type AuthEmailMessage, createAuthEmail } from './auth-email.templates.js';
import {
  AuthEmailDeliveryError,
  type AuthEmailQueueService,
  type AuthEmailRateSlot,
  type SecurityAuthEmailInput,
} from './auth-email-queue.service.js';
import {
  CloudMailRefusedError,
  type CloudMailState,
  type CloudMailTransport,
  cloudMailData,
} from './auth-mail-cloud.js';

const SMTP_SETTING_KEY = 'auth:smtp';
/** How long an action a person waits on follows its email before answering "queued". */
const DELIVERY_WAIT_MS = 15_000;
/** Refusals of the cloud email that name their reason (the worker fails the job with `CODE: message`). */
const CLOUD_REFUSAL = /^(MAIL_QUOTA|MAIL_INVALID|MAIL_KIND):\s*(.*)$/s;

export type SmtpTlsMode = 'starttls' | 'tls';
export const SMTP_TEST_EMAIL_KINDS = ['smtp_configuration', 'password_setup', 'password_reset', 'email_otp'] as const;
export type SmtpTestEmailKind = (typeof SMTP_TEST_EMAIL_KINDS)[number];

export interface SmtpPublicConfig {
  configured: boolean;
  host: string | null;
  port: number | null;
  tlsMode: SmtpTlsMode | null;
  username: string | null;
  passwordLast4: string | null;
  senderName: string | null;
  senderEmail: string | null;
  verifiedAt: string | null;
  /**
   * How sign-in emails leave: the installation's own SMTP, or the cloud email of a managed installation (then
   * `configured` and `verifiedAt` describe the cloud email, and the other fields the saved own SMTP, if any).
   */
  transport: 'smtp' | 'cloud';
  /** Managed installations whose Opfield account set up cloud email; null elsewhere. */
  cloud: CloudMailState | null;
}

interface StoredSmtpConfig {
  host: string;
  port: number;
  tlsMode: SmtpTlsMode;
  username: string;
  senderName: string;
  senderEmail: string;
  password: { encryptedKey: string; encryptedDek: string };
  verifiedAt: string | null;
}

export interface SmtpConfigInput {
  host: string;
  port: number;
  tlsMode: SmtpTlsMode;
  username: string;
  password?: string;
  senderName: string;
  senderEmail: string;
}

export class AuthMailService {
  private cloudTransport: CloudMailTransport | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly authEmailQueue: AuthEmailQueueService
  ) {}

  /** The cloud email of a managed installation (set once the cloud link is up). */
  setCloudTransport(transport: CloudMailTransport | null): void {
    this.cloudTransport = transport;
  }

  /** The cloud email state; null without a cloud link, or when it cannot be read (then own SMTP applies). */
  async cloudState(): Promise<CloudMailState | null> {
    if (!this.cloudTransport) return null;
    try {
      const state = await this.cloudTransport.state();
      return state.available ? state : null;
    } catch {
      return null;
    }
  }

  /** The owner's "Use my own SMTP" switch of a managed installation with cloud email. */
  async setTransport(transport: 'smtp' | 'cloud', userId: string | null): Promise<void> {
    const state = await this.cloudState();
    if (!this.cloudTransport || !state) {
      if (transport === 'smtp') return;
      throw new AppError(409, 'CLOUD_MAIL_UNAVAILABLE', 'Opfield Cloud email is not available on this installation');
    }
    await this.cloudTransport.setOwnSmtp(transport === 'smtp', userId);
  }

  async getPublicConfig(): Promise<SmtpPublicConfig> {
    const [config, cloud] = await Promise.all([this.getStoredConfig(), this.cloudState()]);
    const transport = cloud?.active ? 'cloud' : 'smtp';
    const effective =
      transport === 'cloud'
        ? { configured: true, verifiedAt: cloud?.since ?? new Date(0).toISOString() }
        : { configured: config !== null, verifiedAt: config?.verifiedAt ?? null };
    if (!config) {
      return {
        ...effective,
        host: null,
        port: null,
        tlsMode: null,
        username: null,
        passwordLast4: null,
        senderName: null,
        senderEmail: null,
        transport,
        cloud,
      };
    }
    return {
      ...effective,
      host: config.host,
      port: config.port,
      tlsMode: config.tlsMode,
      username: config.username,
      passwordLast4: this.getPasswordLast4(config.password),
      senderName: config.senderName,
      senderEmail: config.senderEmail,
      transport,
      cloud,
    };
  }

  /** Whether the saved own SMTP is verified, whatever transport is in use. */
  async ownSmtpVerified(): Promise<boolean> {
    return Boolean((await this.getStoredConfig())?.verifiedAt);
  }

  async saveConfig(input: SmtpConfigInput): Promise<SmtpPublicConfig> {
    const config = await this.buildConfig(input);
    await this.setStoredConfig(config);
    return this.getPublicConfig();
  }

  async verifyAndSaveConfig(input: SmtpConfigInput): Promise<SmtpPublicConfig> {
    const config = await this.buildConfig(input);
    const transport = this.createTransport(config);
    try {
      await transport.verify();
    } catch {
      throw new AppError(502, 'SMTP_CONNECTION_FAILED', 'Unable to connect to the SMTP server');
    }
    await this.setStoredConfig({ ...config, verifiedAt: new Date().toISOString() });
    return this.getPublicConfig();
  }

  async sendTestEmail(recipient: string, kind: SmtpTestEmailKind = 'smtp_configuration'): Promise<void> {
    const config = await this.requireStoredConfig();
    await this.sendWithConfig(config, recipient, createAuthEmail(getTestEmailInput(kind)));
    await this.setStoredConfig({ ...config, verifiedAt: new Date().toISOString() });
  }

  /**
   * A test through the transport in use: the cloud email (the account renders it), or the saved own SMTP. Test links
   * point at the public URL, which the account accepts.
   */
  async sendTransportTest(
    recipient: string,
    kind: SmtpTestEmailKind = 'smtp_configuration',
    publicUrl: string | null = null
  ): Promise<void> {
    const cloud = await this.cloudState();
    if (!cloud?.active) {
      await this.sendTestEmail(recipient, kind);
      return;
    }
    const input = getTestEmailInput(kind, publicUrl);
    try {
      await this.sendCloud(recipient, input, randomUUID());
    } catch (error) {
      if (error instanceof CloudMailRefusedError) {
        throw new AppError(error.code === 'MAIL_QUOTA' ? 429 : 400, error.code, error.message);
      }
      throw new AppError(
        502,
        'CLOUD_MAIL_DELIVERY_FAILED',
        `Opfield Cloud email could not send the test: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Queues a sign-in email. With `wait` (an administrator's action) it follows the delivery for up to 15 s: `sent`,
   * `queued` when it is still on its way, or an error with the reason when it failed for good. Public flows do not
   * wait, so their answers stay the same whatever happens to the email.
   */
  async sendSecurityEmail(
    recipient: string,
    input: SecurityAuthEmailInput,
    options: { wait?: boolean; rateSlot?: AuthEmailRateSlot } = {}
  ): Promise<'sent' | 'queued'> {
    if (!(await this.cloudState())?.active) {
      const config = await this.requireStoredConfig();
      if (!config.verifiedAt)
        throw new AppError(503, 'SMTP_NOT_VERIFIED', 'SMTP must be verified before sending authentication email');
    }
    if (!options.wait) {
      await this.authEmailQueue.enqueue(recipient, input, options.rateSlot);
      return 'queued';
    }
    try {
      return await this.authEmailQueue.enqueueAndWait(recipient, input, DELIVERY_WAIT_MS, options.rateSlot);
    } catch (error) {
      if (!(error instanceof AuthEmailDeliveryError)) throw error;
      const refusal = CLOUD_REFUSAL.exec(error.reason);
      if (refusal) {
        throw new AppError(refusal[1] === 'MAIL_QUOTA' ? 429 : 400, refusal[1]!, refusal[2]?.trim() || error.reason);
      }
      throw new AppError(502, 'EMAIL_DELIVERY_FAILED', `The email could not be sent: ${error.reason}`);
    }
  }

  /**
   * The queue worker's delivery: over the cloud link while cloud email is in use (`dedupKey` is the same on every
   * retry, so the account sends it once), else over the own SMTP. A CloudMailRefusedError is final.
   */
  async deliverSecurityEmail(recipient: string, input: SecurityAuthEmailInput, dedupKey?: string): Promise<void> {
    if ((await this.cloudState())?.active) {
      await this.sendCloud(recipient, input, dedupKey ?? randomUUID());
      return;
    }
    const config = await this.requireStoredConfig();
    if (!config.verifiedAt)
      throw new AppError(503, 'SMTP_NOT_VERIFIED', 'SMTP must be verified before sending authentication email');
    await this.sendWithConfig(config, recipient, createAuthEmail(input));
  }

  async snapshotConfig(): Promise<StoredSmtpConfig | null> {
    return this.getStoredConfig();
  }

  async restoreConfig(snapshot: StoredSmtpConfig | null): Promise<void> {
    if (snapshot) {
      await this.setStoredConfig(snapshot);
      return;
    }
    await this.db.delete(settings).where(eq(settings.key, SMTP_SETTING_KEY));
  }

  private async sendCloud(recipient: string, input: AuthEmailInput, dedupKey: string): Promise<void> {
    if (!this.cloudTransport) throw new Error('The cloud link is not running');
    await this.cloudTransport.send({
      kind: input.kind,
      to: recipient,
      locale: 'en',
      dedupKey,
      data: cloudMailData(input),
    });
  }

  private async sendWithConfig(config: StoredSmtpConfig, recipient: string, message: AuthEmailMessage): Promise<void> {
    const transport = this.createTransport(config);
    try {
      await transport.sendMail({
        from: config.senderName ? `${config.senderName} <${config.senderEmail}>` : config.senderEmail,
        to: recipient,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch {
      throw new AppError(502, 'SMTP_DELIVERY_FAILED', 'Unable to deliver authentication email');
    }
  }

  private createTransport(config: StoredSmtpConfig) {
    return nodemailer.createTransport(
      new SMTPTransport({
        host: config.host,
        port: config.port,
        secure: config.tlsMode === 'tls',
        requireTLS: config.tlsMode === 'starttls',
        auth: { user: config.username, pass: this.cryptoService.decryptString(config.password) },
      })
    );
  }

  private async buildConfig(input: SmtpConfigInput): Promise<StoredSmtpConfig> {
    const previous = await this.getStoredConfig();
    const password = input.password?.trim() ? this.cryptoService.encryptString(input.password) : previous?.password;
    if (!password) throw new AppError(400, 'SMTP_PASSWORD_REQUIRED', 'SMTP password is required');
    return {
      host: input.host.trim(),
      port: input.port,
      tlsMode: input.tlsMode,
      username: input.username.trim(),
      password,
      senderName: input.senderName.trim(),
      senderEmail: input.senderEmail.trim().toLowerCase(),
      verifiedAt: null,
    };
  }

  private async requireStoredConfig(): Promise<StoredSmtpConfig> {
    const config = await this.getStoredConfig();
    if (!config) throw new AppError(503, 'SMTP_NOT_CONFIGURED', 'SMTP is not configured');
    return config;
  }

  private getPasswordLast4(password: StoredSmtpConfig['password']): string | null {
    const plaintext = this.cryptoService.decryptString(password);
    return plaintext.length >= 4 ? plaintext.slice(-4) : null;
  }

  private async getStoredConfig(): Promise<StoredSmtpConfig | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SMTP_SETTING_KEY)).limit(1);
    return (row?.value as StoredSmtpConfig | undefined) ?? null;
  }

  private async setStoredConfig(value: StoredSmtpConfig): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: SMTP_SETTING_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}

function getTestEmailInput(kind: SmtpTestEmailKind, publicUrl: string | null = null): AuthEmailInput {
  const origin = publicUrl ? publicUrl.replace(/\/+$/, '') : 'https://opfield.example';
  switch (kind) {
    case 'password_setup':
    case 'password_reset':
      return { kind, actionUrl: `${origin}/reset-password?token=test-link` };
    case 'email_otp':
      return { kind, code: '000000' };
    case 'smtp_configuration':
      return { kind };
  }
}
