import { container } from '@/container.js';
import { isDemoMode } from '@/modules/demo/demo-mode.js';
import { AuthSettingsService } from './auth.settings.service.js';
import { OidcSettingsService } from './oidc-settings.service.js';

export interface PublicAuthMethods {
  oidc: boolean;
  password: boolean;
  emailOtp: boolean;
  passkeyLogin: boolean;
  demoEmailOtp?: true;
  /** Name on the OIDC button ("Sign in with <name>"); null for the plain "Sign in with SSO". */
  oidcDisplayName?: string | null;
  /** The OIDC provider is the Opfield account of a managed installation. */
  oidcOpfieldAccount?: boolean;
}

export async function getPublicAuthMethods(): Promise<PublicAuthMethods> {
  if (isDemoMode()) {
    return { oidc: false, password: false, emailOtp: false, passkeyLogin: false, demoEmailOtp: true };
  }

  const [{ methods }, oidc] = await Promise.all([
    container.resolve(AuthSettingsService).getConfig(),
    container.resolve(OidcSettingsService).getPublicConfig(),
  ]);
  const oidcEnabled = methods.oidc && oidc.configured;

  return {
    ...methods,
    oidc: oidcEnabled,
    oidcDisplayName: oidcEnabled ? (oidc.displayName ?? null) : null,
    oidcOpfieldAccount: oidcEnabled && oidc.opfieldAccount === true,
  };
}
