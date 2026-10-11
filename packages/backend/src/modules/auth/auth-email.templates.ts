import { GRAPHITE } from '@/lib/brand-palette.js';

export type AuthEmailKind =
  | 'smtp_configuration'
  | 'password_setup'
  | 'password_reset'
  | 'email_otp_enabled'
  | 'email_otp'
  | 'account_invitation';

/** How an invited user signs in; decides the one sign-in hint in the invitation. */
export type AccountInvitationSignIn = 'oidc' | 'password' | 'email_otp';

export type AuthEmailInput =
  | { kind: 'smtp_configuration' }
  | { kind: 'password_setup'; actionUrl: string }
  | { kind: 'password_reset'; actionUrl: string }
  | { kind: 'email_otp_enabled'; actionUrl: string }
  | { kind: 'email_otp'; code: string }
  | { kind: 'account_invitation'; actionUrl: string; email: string; signIn: AccountInvitationSignIn };

export interface AuthEmailMessage {
  subject: string;
  text: string;
  html: string;
}

interface EmailContent {
  subject: string;
  title: string;
  body: string;
  text: string;
  securityNote: string;
  action?: { label: string; url: string };
  code?: string;
  badge?: string;
}

export function createAuthEmail(input: AuthEmailInput): AuthEmailMessage {
  const content = getEmailContent(input);
  return {
    subject: content.subject,
    text: content.text,
    html: renderAuthEmail(content),
  };
}

function getEmailContent(input: AuthEmailInput): EmailContent {
  switch (input.kind) {
    case 'password_setup':
      return {
        subject: 'Opfield: set your password',
        title: 'Create a password for your Opfield account',
        body: 'An administrator enabled password sign-in for your account. Set a password to use this account directly in Opfield.',
        text: `Set your Opfield password: ${input.actionUrl}\n\nThis link expires in 30 minutes and can be used once.`,
        securityNote:
          'This link is valid for 30 minutes and can be used once. If you were not expecting this email, you can safely ignore it.',
        action: { label: 'Set password', url: input.actionUrl },
      };
    case 'password_reset':
      return {
        subject: 'Opfield: reset your password',
        title: 'Reset your Opfield password',
        body: 'We received a request to reset the password for your Opfield account.',
        text: `Reset your Opfield password: ${input.actionUrl}\n\nThis link expires in 30 minutes and can be used once.`,
        securityNote:
          'This link is valid for 30 minutes and can be used once. If you did not request a password reset, no action is required.',
        action: { label: 'Reset password', url: input.actionUrl },
      };
    case 'email_otp_enabled':
      return {
        subject: 'Opfield: email-code sign-in enabled',
        title: 'Email-code sign-in is enabled',
        body: 'An administrator enabled email-code sign-in for your Opfield account. Enter your email address at sign-in to receive a one-time code.',
        text: `An administrator enabled email-code sign-in for your Opfield account. Open Opfield: ${input.actionUrl}`,
        securityNote:
          'A new one-time code is sent for each sign-in and expires after 10 minutes. We will never ask for a code by phone, chat, or email.',
        action: { label: 'Open Opfield', url: input.actionUrl },
      };
    case 'email_otp':
      return {
        subject: 'Your Opfield sign-in code',
        title: 'Your Opfield sign-in code',
        body: 'Enter this code to continue signing in to Opfield.',
        text: `Your Opfield sign-in code is ${input.code}. It expires in 10 minutes.`,
        securityNote:
          'This code expires in 10 minutes. We will never ask for it by phone, chat, or email. If you did not start this sign-in, no action is required.',
        code: input.code,
      };
    case 'account_invitation': {
      const signInHint = ACCOUNT_INVITATION_SIGN_IN_HINTS[input.signIn];
      return {
        subject: 'Opfield: an account was created for you',
        title: 'Your Opfield account is ready',
        body: `An administrator created an Opfield account for ${input.email}. ${signInHint}`,
        text: `An administrator created an Opfield account for ${input.email}. ${signInHint}\n\nSign in to Opfield: ${input.actionUrl}`,
        securityNote:
          'Opfield will never ask for your password or a sign-in code by phone, chat, or email. If you were not expecting this account, contact your administrator.',
        action: { label: 'Sign in to Opfield', url: input.actionUrl },
      };
    }
    case 'smtp_configuration':
      return {
        subject: 'Opfield SMTP test',
        title: 'Your Opfield email delivery is working',
        body: 'This test message confirms that Opfield can deliver authentication email through the SMTP configuration you just saved.',
        text: 'Opfield SMTP configuration is working. No action is required.',
        securityNote: 'No action is required. This message does not grant access or change any account settings.',
        badge: 'SMTP test',
      };
  }
}

const ACCOUNT_INVITATION_SIGN_IN_HINTS: Record<AccountInvitationSignIn, string> = {
  oidc: "Sign in with your organization's single sign-on (SSO) provider using this email address.",
  password:
    'A separate email contains a link to set your password (if it has expired, ask your administrator for a new one); then sign in with this email address and your password.',
  email_otp: 'Enter this email address at sign-in and Opfield will email you a one-time code.',
};

function renderAuthEmail(content: EmailContent): string {
  const action = content.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px"><tr><td style="border:1px solid ${GRAPHITE.ink};background:${GRAPHITE.ink}"><a href="${escapeHtml(content.action.url)}" style="display:inline-block;padding:13px 19px;color:${GRAPHITE.page};font-family:Arial,sans-serif;font-size:14px;font-weight:600;line-height:1;text-decoration:none">${escapeHtml(content.action.label)}</a></td></tr></table><p style="margin:24px 0 0;overflow-wrap:anywhere;color:${GRAPHITE.amber};font-family:Arial,sans-serif;font-size:13px;line-height:1.5"><a href="${escapeHtml(content.action.url)}" style="color:${GRAPHITE.amber};text-decoration:underline">${escapeHtml(content.action.url)}</a></p>`
    : '';
  const code = content.code
    ? `<div style="margin-top:26px;border:1px solid ${GRAPHITE.hairStrong};background:${GRAPHITE.recess};color:${GRAPHITE.ink};padding:18px;font-family:Consolas,'Liberation Mono',monospace;font-size:32px;font-weight:700;letter-spacing:0.22em;line-height:1;text-align:center">${escapeHtml(content.code)}</div>`
    : '';
  const badge = content.badge
    ? `<span style="display:inline-block;margin-bottom:19px;border:1px solid ${GRAPHITE.hairStrong};background:${GRAPHITE.raised};color:${GRAPHITE.soft};padding:5px 9px;font-family:Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase">${escapeHtml(content.badge)}</span>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:${GRAPHITE.page};color:${GRAPHITE.ink}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${GRAPHITE.page}">
      <tr><td align="center" style="padding:20px">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;border:1px solid ${GRAPHITE.hair};background:${GRAPHITE.surface}">
          <tr><td style="height:1px;background:${GRAPHITE.amber};font-size:1px;line-height:1px">&nbsp;</td></tr>
          <tr><td style="padding:40px 42px 38px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="padding-right:9px"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="4 4 40 40" style="display:block"><g fill="${GRAPHITE.ink}"><rect x="19.5" y="4.5" width="9" height="9" rx="2.4"/><rect x="30.1" y="8.9" width="9" height="9" rx="2.4"/><rect x="34.5" y="19.5" width="9" height="9" rx="2.4"/><rect x="30.1" y="30.1" width="9" height="9" rx="2.4"/><rect x="19.5" y="34.5" width="9" height="9" rx="2.4"/><rect x="8.9" y="30.1" width="9" height="9" rx="2.4"/><rect x="4.5" y="19.5" width="9" height="9" rx="2.4"/><rect x="8.9" y="8.9" width="9" height="9" rx="2.4"/></g></svg></td>
              <td style="color:${GRAPHITE.ink};font-family:Arial,sans-serif;font-size:16px;font-weight:600;letter-spacing:-0.3px">opfield</td>
            </tr></table>
            <div style="height:1px;margin:29px 0;background:${GRAPHITE.hair};font-size:1px;line-height:1px">&nbsp;</div>
            ${badge}
            <h1 style="margin:0;color:${GRAPHITE.ink};font-family:Arial,sans-serif;font-size:27px;font-weight:600;letter-spacing:-1px;line-height:1.16">${escapeHtml(content.title)}</h1>
            <p style="margin:18px 0 0;color:${GRAPHITE.soft};font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${escapeHtml(content.body)}</p>
            ${code}
            ${action}
            <p style="margin:28px 0 0;border-left:2px solid ${GRAPHITE.amber};background:${GRAPHITE.raised};color:${GRAPHITE.soft};padding:12px 14px;font-family:Arial,sans-serif;font-size:13px;line-height:1.5">${escapeHtml(content.securityNote)}</p>
          </td></tr>
          <tr><td style="border-top:1px solid ${GRAPHITE.hair};padding:23px 42px 28px;color:${GRAPHITE.stone};font-family:Arial,sans-serif;font-size:12px;line-height:1.55">Opfield — Infrastructure control plane.<br><a href="https://opfield.dev" style="color:${GRAPHITE.ink};font-weight:400;opacity:0.65;text-decoration:underline">Powered by Opfield</a></td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };
    return entities[character];
  });
}
