import type { UpdateAuthProvisioningSettingsInput } from '@/modules/admin/admin.schemas.js';
import { normalizePublicUrl } from '@/modules/settings/general-settings.service.js';

/**
 * Settings that decide who can prove an identity to Opfield: the mail server
 * that delivers password-reset and sign-in codes, the identity provider, the
 * public URL embedded in emailed links, and whether unverified IdP emails may
 * claim pre-created accounts. Changing any of them is equivalent to being able
 * to take over accounts, so it requires admin:system rather than
 * settings:opfield:edit. Values that are resubmitted unchanged are allowed.
 */
export async function findIdentityTrustChanges(
  input: UpdateAuthProvisioningSettingsInput,
  current: {
    smtp: () => Promise<{
      configured: boolean;
      host: string | null;
      port: number | null;
      tlsMode: string | null;
      username: string | null;
      senderName: string | null;
      senderEmail: string | null;
      transport?: 'smtp' | 'cloud';
    }>;
    generalSettings: () => Promise<{ publicUrl: string | null }>;
    authSettings: () => Promise<{ oidcRequireVerifiedEmail: boolean }>;
  }
): Promise<string[]> {
  const changes: string[] = [];
  if (input.smtp) {
    const smtp = await current.smtp();
    const unchanged =
      smtp.configured &&
      !input.smtp.password?.trim() &&
      smtp.host === input.smtp.host.trim() &&
      smtp.port === input.smtp.port &&
      smtp.tlsMode === input.smtp.tlsMode &&
      smtp.username === input.smtp.username.trim() &&
      smtp.senderName === input.smtp.senderName.trim() &&
      smtp.senderEmail === input.smtp.senderEmail.trim().toLowerCase();
    if (!unchanged) changes.push('SMTP');
  }
  if (input.smtpTransport !== undefined && input.smtpTransport !== (await current.smtp()).transport) {
    changes.push('the email transport');
  }
  if (input.oidc || input.oidcProviderAction) changes.push('the OIDC provider');
  if (input.generalSettings?.publicUrl !== undefined) {
    const { publicUrl } = await current.generalSettings();
    if (normalizePublicUrl(input.generalSettings.publicUrl) !== publicUrl) changes.push('the public URL');
  }
  if (input.oidcRequireVerifiedEmail === false && (await current.authSettings()).oidcRequireVerifiedEmail) {
    changes.push('OIDC verified-email enforcement');
  }
  return changes;
}
