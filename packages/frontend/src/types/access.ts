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
  sharedPasswordSet: boolean;
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

/** Setting `access.signIn`: how long visitors stay signed in unless a list sets its own length. */
export interface AccessSignInSettings {
  defaultSessionTtlSeconds: number;
}

export type AccessSignInSettingsUpdate = AccessSignInSettings;

export type AccessIdentityProviderKind = "google" | "oidc";

export interface AccessIdentityProvider {
  id: string;
  kind: AccessIdentityProviderKind;
  name: string;
  issuer: string;
  clientId: string;
  /** Claim the SSO group rules read; null: no groups. */
  groupsClaim: string | null;
  /** A missing email_verified claim counts as verified; email_verified false never does. */
  trustEmail: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccessIdentityProviderRequest {
  kind: AccessIdentityProviderKind;
  name: string;
  issuer?: string;
  clientId: string;
  /** Write-only: blank keeps the stored secret. */
  clientSecret?: string;
  groupsClaim?: string | null;
  trustEmail?: boolean;
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
