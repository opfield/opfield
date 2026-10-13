import { eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { type AuthEmailInput, type AuthEmailMessage, createAuthEmail } from './auth-email.templates.js';
import type { AuthEmailQueueService, SecurityAuthEmailInput } from './auth-email-queue.service.js';

const SMTP_SETTING_KEY = 'auth:smtp';

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
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly authEmailQueue: AuthEmailQueueService
  ) {}

  async getPublicConfig(): Promise<SmtpPublicConfig> {
    const config = await this.getStoredConfig();
    if (!config) {
      return {
        configured: false,
        host: null,
        port: null,
        tlsMode: null,
        username: null,
        passwordLast4: null,
        senderName: null,
        senderEmail: null,
        verifiedAt: null,
      };
    }
    return {
      configured: true,
      host: config.host,
      port: config.port,
      tlsMode: config.tlsMode,
      username: config.username,
      passwordLast4: this.getPasswordLast4(config.password),
      senderName: config.senderName,
      senderEmail: config.senderEmail,
      verifiedAt: config.verifiedAt,
    };
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

  async sendSecurityEmail(recipient: string, input: SecurityAuthEmailInput): Promise<void> {
    const config = await this.requireStoredConfig();
    if (!config.verifiedAt)
      throw new AppError(503, 'SMTP_NOT_VERIFIED', 'SMTP must be verified before sending authentication email');
    await this.authEmailQueue.enqueue(recipient, input);
  }

  async deliverSecurityEmail(recipient: string, input: SecurityAuthEmailInput): Promise<void> {
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

function getTestEmailInput(kind: SmtpTestEmailKind): AuthEmailInput {
  switch (kind) {
    case 'password_setup':
    case 'password_reset':
      return { kind, actionUrl: 'https://opfield.example/reset-password?token=test-link' };
    case 'email_otp':
      return { kind, code: '000000' };
    case 'smtp_configuration':
      return { kind };
  }
}
