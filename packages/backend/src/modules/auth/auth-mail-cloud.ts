import type { AuthEmailInput } from './auth-email.templates.js';

/** Sending limits of the cloud email (per UTC calendar month, UTC day and clock hour). */
export interface CloudMailLimits {
  month: number;
  day: number;
  hour: number;
}

/** The cloud email of a managed installation, as Settings → SMTP shows it. */
export interface CloudMailState {
  /** The Opfield account set up cloud email for this installation. */
  available: boolean;
  /** Sign-in emails go through it now (available, and the owner did not choose their own SMTP). */
  active: boolean;
  /** The owner chose their own SMTP instead. */
  ownSmtp: boolean;
  from: string | null;
  limits: CloudMailLimits | null;
  /** When the account set it up; the verified time of the cloud transport. */
  since: string | null;
}

/** One email the account renders and sends (the `mail` request of the cloud link). Never HTML. */
export interface CloudMailMessage {
  kind: AuthEmailInput['kind'];
  to: string;
  locale: string;
  /** The same key on every retry of one email: the account sends it once. */
  dedupKey: string;
  data: { actionUrl?: string; code?: string; email?: string; signIn?: 'oidc' | 'password' | 'email_otp' };
}

/** What the cloud link offers the mail service on a managed installation. */
export interface CloudMailTransport {
  state(): Promise<CloudMailState>;
  /** The owner's "Use my own SMTP" switch. */
  setOwnSmtp(own: boolean, userId: string | null): Promise<CloudMailState>;
  /** Resolves once the account took the email; throws CloudMailRefusedError when it never will. */
  send(message: CloudMailMessage): Promise<void>;
}

/** Account answers that a retry cannot change (quota, invalid message, unknown kind). */
export const PERMANENT_CLOUD_MAIL_CODES = ['MAIL_QUOTA', 'MAIL_INVALID', 'MAIL_KIND'] as const;

/** The account refused the email for good: the delivery fails at once, without retries. */
export class CloudMailRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAt: string | null = null
  ) {
    super(message);
    this.name = 'CloudMailRefusedError';
  }
}

/** The data fields of one email, as the account's templates take them. */
export function cloudMailData(input: AuthEmailInput): CloudMailMessage['data'] {
  switch (input.kind) {
    case 'smtp_configuration':
      return {};
    case 'password_setup':
    case 'password_reset':
    case 'email_otp_enabled':
      return { actionUrl: input.actionUrl };
    case 'email_otp':
      return { code: input.code };
    case 'account_invitation':
      return { actionUrl: input.actionUrl, email: input.email, signIn: input.signIn };
  }
}
