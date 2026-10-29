import type { AccessIdentityProvider, AccessRuleSelector, AccessSignInMethod } from "@/types";

export const SELECTORS: { value: AccessRuleSelector; label: string }[] = [
  { value: "everyone", label: "Everyone" },
  { value: "ip", label: "IP range" },
  { value: "email", label: "Email" },
  { value: "email_domain", label: "Email domain" },
  { value: "opfield_user", label: "Opfield user" },
  { value: "opfield_group", label: "Opfield group" },
  { value: "sso_group", label: "SSO group" },
  { value: "method", label: "Sign-in method" },
  { value: "service_token", label: "Service token" },
];

/** Selectors whose value is picked from a list instead of typed. */
export const CHOICE_SELECTORS = new Set<AccessRuleSelector>([
  "opfield_user",
  "opfield_group",
  "method",
  "service_token",
]);

export const SELECTOR_PLACEHOLDERS: Partial<Record<AccessRuleSelector, string>> = {
  ip: "203.0.113.0/24 or 192.0.2.10",
  email: "name@example.com",
  email_domain: "example.com",
  sso_group: "Group name from the provider",
};

export const ADDRESS_PLACEHOLDER = "203.0.113.0/24 or 192.0.2.10";

/** Session lengths offered for a list and as the installation default, in seconds. */
export const SESSION_LENGTHS: { seconds: number; label: string }[] = [
  { seconds: 3_600, label: "1 hour" },
  { seconds: 8 * 3_600, label: "8 hours" },
  { seconds: 86_400, label: "24 hours" },
  { seconds: 7 * 86_400, label: "7 days" },
  { seconds: 30 * 86_400, label: "30 days" },
];

/** "24 hours", or a plain count for a length set outside the presets. */
export function sessionLengthLabel(seconds: number): string {
  const preset = SESSION_LENGTHS.find((length) => length.seconds === seconds);
  if (preset) return preset.label;
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

/** "id.acme.dev" from an issuer URL; the URL itself when it does not parse. */
export function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

export interface SignInMethodRow {
  key: AccessSignInMethod;
  title: string;
  description: string;
}

const OPFIELD_METHOD: SignInMethodRow = {
  key: "opfield",
  title: "Opfield account",
  description: "People with an account on this Opfield",
};

const LIST_METHODS: SignInMethodRow[] = [
  {
    key: "password",
    title: "Username and password",
    description: "A sign-in form for the users below",
  },
  {
    key: "basic",
    title: "Basic authentication",
    description: "The browser's password prompt; scripts send an Authorization header",
  },
  { key: "shared", title: "Shared password", description: "One password for every visitor" },
];

function providerRow(provider: AccessIdentityProvider): SignInMethodRow {
  return {
    key: `idp:${provider.id}`,
    title: provider.name,
    description:
      provider.kind === "google"
        ? "Any Google account; the rules decide who gets in"
        : `OIDC · ${issuerHost(provider.issuer)}`,
  };
}

/**
 * The rows of the Sign-in methods panel: Opfield account, every identity provider, then the
 * list's own methods. A provider method of the list that is not among `providers` (removed, or
 * the providers could not be loaded) keeps a row so it can be turned off.
 */
export function signInMethodRows(
  providers: AccessIdentityProvider[] | null,
  enabled: readonly AccessSignInMethod[]
): SignInMethodRow[] {
  const known = (providers ?? []).map(providerRow);
  const unknown = enabled
    .filter((key) => key.startsWith("idp:") && !known.some((row) => row.key === key))
    .map((key) => ({
      key,
      title: providers ? "Removed identity provider" : "Identity provider",
      description: providers
        ? "Visitors can no longer sign in with it"
        : "Its settings are in Sign-in settings",
    }));
  return [OPFIELD_METHOD, ...known, ...unknown, ...LIST_METHODS];
}

/** The name a sign-in method goes by: "Google", "Opfield account", "Shared password". */
export function signInMethodTitle(key: string, providers: AccessIdentityProvider[] | null): string {
  return (
    signInMethodRows(providers, key.startsWith("idp:") ? [key as AccessSignInMethod] : []).find(
      (row) => row.key === key
    )?.title ?? key
  );
}
