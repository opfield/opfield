// Access lists and the sign-in that protects routes and Pages: sign-in methods, Include / Require /
// Exclude rules, the installation's sign-in settings, identity providers and service tokens.

/**
 * A sign-in method an access list offers: `opfield` (an account of this Opfield), `password` (the
 * sign-in form for the list's users), `basic` (HTTP basic authentication with the list's users),
 * `shared` (one password for every visitor) or `idp:<provider id>` (Google or an OIDC provider).
 */
export type AccessSignInMethod = "opfield" | "password" | "basic" | "shared" | `idp:${string}`;

/** What a rule matches; `everyone` matches any signed-in visitor and has no values. */
export type AccessRuleSelector =
  | "everyone"
  | "ip"
  | "email"
  | "email_domain"
  | "opfield_user"
  | "opfield_group"
  | "sso_group"
  | "method"
  | "service_token";

/** A rule matches when its selector matches any of `values`. */
export interface AccessRule {
  selector: AccessRuleSelector;
  values: string[];
}

export interface AccessListUser {
  username: string;
}

export interface AccessList {
  id: string;
  name: string;
  description: string | null;
  signInMethods: AccessSignInMethod[];
  /** Users of the sign-in form and basic authentication. */
  users: AccessListUser[];
  hasSharedPassword: boolean;
  /** Addresses (IP or CIDR) that get in without signing in. */
  skipIpRanges: string[];
  includeRules: AccessRule[];
  requireRules: AccessRule[];
  excludeRules: AccessRule[];
  /** Null: the default session length of the sign-in settings. */
  sessionTtlSeconds: number | null;
  /** Access list folder; null is ungrouped. */
  folderId?: string | null;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
  usageCount?: number;
}

export interface CreateAccessListRequest {
  name: string;
  description?: string;
  signInMethods: AccessSignInMethod[];
  /** A blank password keeps the stored one of that username. */
  users: { username: string; password?: string }[];
  /** Undefined keeps the stored shared password, null clears it. */
  sharedPassword?: string | null;
  skipIpRanges: string[];
  includeRules: AccessRule[];
  requireRules: AccessRule[];
  excludeRules: AccessRule[];
  sessionTtlSeconds: number | null;
  /** Destination folder on create (null: ungrouped). */
  folderId?: string | null;
}

/** Setting `access.signIn`: where visitors sign in and how long they stay signed in. */
export interface AccessSignInSettings {
  /** Null: the Opfield address serves the sign-in pages. */
  domain: string | null;
  defaultSessionTtlSeconds: number;
}

export type AccessIdentityProviderKind = "google" | "oidc";

export interface AccessIdentityProvider {
  id: string;
  kind: AccessIdentityProviderKind;
  name: string;
  issuer: string;
  clientId: string;
  /** Claim the SSO group rules read; null: no groups. */
  groupsClaim: string | null;
  /** The callback address to register with the provider, when the server reports it. */
  redirectUri?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccessIdentityProviderRequest {
  /** A new provider's id, so its redirect URI can be shown before it is saved. */
  id?: string;
  kind: AccessIdentityProviderKind;
  name: string;
  issuer?: string;
  clientId: string;
  /** Write-only: blank keeps the stored secret. */
  clientSecret?: string;
  groupsClaim?: string | null;
}

export interface AccessServiceToken {
  id: string;
  name: string;
  clientId: string;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A created token: the secret is returned this once. */
export interface AccessServiceTokenCreated extends AccessServiceToken {
  clientSecret: string;
}

// ── Public sign-in page ──────────────────────────────────────────────────

export type AccessSignInMethodKind = "opfield" | "idp" | "password" | "shared";

export interface AccessSignInMethodOption {
  key: string;
  label: string;
  kind: AccessSignInMethodKind;
}

export type AccessSignInContext =
  | { redirect: string }
  | {
      host: string;
      methods: AccessSignInMethodOption[];
      state: "methods" | "denied";
      identity?: { email?: string; name?: string };
    };
