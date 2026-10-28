import type { UpdateAuthProvisioningSettingsInput } from '@/modules/admin/admin.schemas.js';
import { normalizePublicUrl } from '@/modules/settings/general-settings.service.js';

function cidrList(values: readonly string[]): string {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .join(',');
}

/** Whether a partial update names a value other than the current one. */
function differs<T extends object>(input: Partial<T> | undefined, current: T): boolean {
  if (!input) return false;
  return (Object.keys(input) as Array<keyof T>).some((key) => {
    const value = input[key];
    if (value === undefined) return false;
    const now = current[key];
    return Array.isArray(value) && Array.isArray(now) ? cidrList(value) !== cidrList(now) : value !== now;
  });
}

/**
 * Settings that decide who can prove an identity to Opfield, and from where: the mail server that delivers
 * password-reset and sign-in codes, the identity provider, the public URL embedded in emailed links, whether
 * unverified IdP emails may claim pre-created accounts, OIDC auto-provisioning and the group it gives, the sign-in
 * methods and the MFA grace period of existing sessions. With them go the client-IP trust (token address limits,
 * rate limits and audit addresses depend on it) and the outbound webhook private-network policy (what other
 * principals' webhooks may reach inside the network). Changing any of them is equivalent to being able to take over
 * accounts or reach internal services, so it requires admin:system rather than settings:opfield:edit. Values that are
 * resubmitted unchanged are allowed.
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
    authSettings: () => Promise<{
      oidcRequireVerifiedEmail: boolean;
      oidcAutoCreateUsers: boolean;
      oidcDefaultGroupId: string;
      mfaExistingSessionGracePeriodDays: number;
      methods: { oidc: boolean; password: boolean; emailOtp: boolean; passkeyLogin: boolean };
    }>;
    networkSecurity: () => Promise<{
      clientIpSource: string;
      trustedProxyCidrs: string[];
      trustCloudflareHeaders: boolean;
    }>;
    outboundWebhookPolicy: () => Promise<{ allowPrivateNetworks: boolean; allowedPrivateCidrs: string[] }>;
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
  const touchesAuth =
    input.oidcRequireVerifiedEmail === false ||
    input.oidcAutoCreateUsers !== undefined ||
    input.oidcDefaultGroupId !== undefined ||
    input.mfaExistingSessionGracePeriodDays !== undefined ||
    input.methods !== undefined;
  if (touchesAuth) {
    const auth = await current.authSettings();
    if (input.oidcRequireVerifiedEmail === false && auth.oidcRequireVerifiedEmail) {
      changes.push('OIDC verified-email enforcement');
    }
    if (
      (input.oidcAutoCreateUsers !== undefined && input.oidcAutoCreateUsers !== auth.oidcAutoCreateUsers) ||
      (input.oidcDefaultGroupId !== undefined && input.oidcDefaultGroupId !== auth.oidcDefaultGroupId)
    ) {
      changes.push('OIDC user auto-creation');
    }
    if (differs(input.methods, auth.methods)) changes.push('the sign-in methods');
    if (
      input.mfaExistingSessionGracePeriodDays !== undefined &&
      input.mfaExistingSessionGracePeriodDays !== auth.mfaExistingSessionGracePeriodDays
    ) {
      changes.push('the MFA grace period');
    }
  }
  if (input.networkSecurity && differs(input.networkSecurity, await current.networkSecurity())) {
    changes.push('client IP trust');
  }
  if (input.outboundWebhookPolicy && differs(input.outboundWebhookPolicy, await current.outboundWebhookPolicy())) {
    changes.push('the outbound webhook policy');
  }
  return changes;
}
