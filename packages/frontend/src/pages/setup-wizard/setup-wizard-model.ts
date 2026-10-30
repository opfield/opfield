import type { LicenseStatusView } from "@/types";
import type { SmtpDraft, SmtpPresetId } from "../settings/smtp-presets";

export type SetupStep =
  | "public-url"
  | "network"
  | "auth-methods"
  | "cloud-connect"
  | "oidc-config"
  | "smtp-config"
  | "admin-details"
  | "admin-2fa"
  | "logging"
  | "finish"
  | "license"
  | "ai-workspace";

/**
 * How people sign in: the Opfield account, the customer's own OIDC provider, or a password with an authenticator
 * app (an email code may be added next to it). Opfield account and OIDC share the one OIDC provider slot.
 */
export type SignInOption = "opfield_account" | "oidc" | "password_totp";

export const SIGN_IN_OPTION_LABELS: Record<SignInOption, string> = {
  opfield_account: "Opfield account",
  oidc: "Your OIDC provider",
  password_totp: "Password + authenticator app",
};

export interface SignInDraft {
  option: SignInOption | null;
  /** The email code next to the password (password with an authenticator app only). */
  emailOtp: boolean;
}
export type LoggingMode = "disabled" | "local" | "external";

export interface AuthMethodsDraft {
  oidc: boolean;
  password: boolean;
  emailOtp: boolean;
}

export interface OidcDraft {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
}

export type SetupSmtpDraft = SmtpDraft;

export interface AdminDraft {
  name: string;
  email: string;
  password: string;
}

/** The administrator the wizard created (the owner). */
export interface SetupAdministrator {
  email: string;
  name: string | null;
  authMethod: string;
  secondFactor: boolean;
}

export interface SetupCloudConnectState {
  connected: boolean;
  accountEmail: string | null;
  administrator: { email: string; name: string | null } | null;
  signInClient: "ready" | "requested" | "none";
  requestedAt: string | null;
}

export interface LoggingDraft {
  mode: LoggingMode;
  url: string;
  username: string;
  password: string;
  database: string;
  table: string;
}

export interface NetworkDraft {
  grpcPublicTarget: string;
  grpcLocalIp: string;
}

export interface SetupConfig {
  administratorCreated: boolean;
  administrator: SetupAdministrator | null;
  cloud: SetupCloudConnectState;
  phase: "configuration" | "ai_workspace";
  license: {
    completed: boolean;
    status: LicenseStatusView;
  };
  general: {
    publicUrl: string | null;
    grpcPublicTarget: string | null;
    grpcLocalIp: string | null;
  };
  networkSuggestions: { publicIps: string[]; localIps: string[] };
  auth: { methods: AuthMethodsDraft };
  smtp: {
    configured: boolean;
    host: string | null;
    port: number | null;
    tlsMode: "starttls" | "tls" | null;
    username: string | null;
    passwordLast4: string | null;
    senderName: string | null;
    senderEmail: string | null;
    verifiedAt: string | null;
  };
  oidc: {
    configured: boolean;
    issuer: string | null;
    clientId: string | null;
    redirectUri: string | null;
    scopes: string;
    opfieldAccount: boolean;
  };
  logging: LoggingDraft & { passwordLast4: string | null };
  transport: { tlsEnabled: boolean };
}

/** The sign-in methods a sign-in option turns on. */
export function getSignInMethods(signIn: SignInDraft): AuthMethodsDraft {
  switch (signIn.option) {
    case "opfield_account":
    case "oidc":
      return { oidc: true, password: false, emailOtp: false };
    case "password_totp":
      return { oidc: false, password: true, emailOtp: signIn.emailOtp };
    default:
      return { oidc: false, password: false, emailOtp: false };
  }
}

/**
 * The options an administrator who exists already leaves open: one created with a password keeps the password with
 * an authenticator app; one created for OIDC keeps an OIDC option. All three before an administrator exists.
 */
export function getAvailableSignInOptions(
  administrator: SetupAdministrator | null
): SignInOption[] {
  if (administrator?.authMethod === "password") return ["password_totp"];
  if (administrator?.authMethod === "oidc") return ["opfield_account", "oidc"];
  return ["opfield_account", "oidc", "password_totp"];
}

/** The option a saved setup state points at: the administrator's, then the configured sign-in. */
export function deriveSignInOption(
  config: Pick<SetupConfig, "administrator" | "auth" | "oidc" | "cloud">
): SignInOption | null {
  const available = getAvailableSignInOptions(config.administrator);
  if (available.length === 1) return available[0]!;
  if (config.cloud.connected && config.oidc.opfieldAccount) return "opfield_account";
  if (config.auth.methods.oidc && config.oidc.configured) return "oidc";
  if (config.auth.methods.password && available.includes("password_totp")) return "password_totp";
  return null;
}

export function getSetupSteps(signIn: SignInDraft, administratorCreated = false): SetupStep[] {
  const { option } = signIn;
  return [
    "public-url",
    "network",
    "auth-methods",
    ...(option === "opfield_account" ? (["cloud-connect"] as const) : []),
    ...(option === "oidc" ? (["oidc-config"] as const) : []),
    ...(option === "password_totp" && signIn.emailOtp ? (["smtp-config"] as const) : []),
    // The Opfield account names the administrator: whoever connected the installation.
    ...(option !== "opfield_account" && !administratorCreated ? (["admin-details"] as const) : []),
    ...(option === "password_totp" ? (["admin-2fa"] as const) : []),
    "logging",
    "finish",
    "license",
    "ai-workspace",
  ];
}

/** The redirect URI of the OIDC provider at a public URL. */
export function oidcRedirectUri(publicUrl: string): string {
  return `${publicUrl.trim().replace(/\/$/, "")}/auth/callback`;
}

/** Where the account portal sends the browser back after Connect with Opfield account. */
export const CLOUD_CALLBACK_PATH = "/setup/cloud-callback";

export interface CloudCallback {
  code: string | null;
  state: string | null;
  /** The person declined at the portal (`error=access_denied`) or the portal reported another error. */
  error: string | null;
}

/** The portal's answer on /setup/cloud-callback; null on any other page. */
export function readCloudCallback(
  location: Pick<Location, "pathname" | "search">
): CloudCallback | null {
  if (location.pathname.replace(/\/$/, "") !== CLOUD_CALLBACK_PATH) return null;
  const params = new URLSearchParams(location.search);
  return {
    code: params.get("code")?.trim() || null,
    state: params.get("state")?.trim() || null,
    error: params.get("error")?.trim() || null,
  };
}

/** A connect code as account.opfield.dev shows it: CLD-XXXX-XXXX (the prefix and dashes are optional). */
export function isCloudCodeValid(value: string): boolean {
  let compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length === 11 && compact.startsWith("CLD")) compact = compact.slice(3);
  return /^[A-HJ-NP-Z2-9]{8}$/.test(compact);
}

export function isPublicUrlValid(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return false;
  }
}

function isValidPort(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (!/^\d+$/.test(value)) return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        /^\d{1,3}$/.test(part) &&
        (part === "0" || !part.startsWith("0")) &&
        Number(part) >= 0 &&
        Number(part) <= 255
    )
  );
}

function isIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    const url = new URL(`http://[${value}]/`);
    return url.hostname.startsWith("[") && url.hostname.endsWith("]");
  } catch {
    return false;
  }
}

function isIp(value: string): boolean {
  return isIpv4(value) || isIpv6(value);
}

function isHostname(value: string): boolean {
  if (value.length > 253 || value.endsWith(".")) return false;
  return value
    .split(".")
    .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

function isHostPortTarget(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[/?#@\s]/.test(trimmed) || trimmed.includes("://")) return false;
  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketedIpv6) return isIpv6(bracketedIpv6[1]!) && isValidPort(bracketedIpv6[2]);
  if (isIp(trimmed)) return true;
  const hostWithPort = trimmed.match(/^([^:]+):(\d+)$/);
  return isHostname(hostWithPort?.[1] ?? trimmed) && isValidPort(hostWithPort?.[2]);
}

function isIpPortTarget(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketedIpv6) return isIpv6(bracketedIpv6[1]!) && isValidPort(bracketedIpv6[2]);
  if (isIp(trimmed)) return true;
  const ipv4WithPort = trimmed.match(/^([^:]+):(\d+)$/);
  return Boolean(ipv4WithPort && isIpv4(ipv4WithPort[1]!) && isValidPort(ipv4WithPort[2]));
}

export function isNetworkDraftValid(draft: NetworkDraft): boolean {
  return isHostPortTarget(draft.grpcPublicTarget) && isIpPortTarget(draft.grpcLocalIp);
}

export function deriveGrpcPublicTarget(publicUrl: string): string {
  try {
    return `${new URL(publicUrl.trim()).hostname}:9443`;
  } catch {
    return "";
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function isOidcDraftValid(draft: OidcDraft, alreadyConfigured: boolean): boolean {
  const scopes = new Set(
    draft.scopes
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  );
  return (
    isHttpUrl(draft.issuer) &&
    Boolean(draft.clientId.trim()) &&
    (alreadyConfigured || Boolean(draft.clientSecret)) &&
    isHttpUrl(draft.redirectUri) &&
    scopes.has("openid")
  );
}

export function isSmtpDraftValid(
  draft: SetupSmtpDraft,
  preset: SmtpPresetId,
  alreadyConfigured: boolean
): boolean {
  const port = Number(draft.port);
  const usernameRequired = preset === "generic" || preset === "postmark";
  return (
    Boolean(draft.host.trim()) &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    (!usernameRequired || Boolean(draft.username.trim())) &&
    (alreadyConfigured || Boolean(draft.password)) &&
    Boolean(draft.senderName.trim()) &&
    isEmail(draft.senderEmail)
  );
}

export function isAdminDraftValid(draft: AdminDraft, withPassword: boolean): boolean {
  return (
    Boolean(draft.name.trim()) &&
    isEmail(draft.email) &&
    (!withPassword || (draft.password.length >= 12 && draft.password.length <= 72))
  );
}

export function isLoggingDraftValid(draft: LoggingDraft, hasSavedPassword: boolean): boolean {
  if (draft.mode !== "external") return true;
  return (
    isHttpUrl(draft.url) &&
    Boolean(draft.username.trim()) &&
    (hasSavedPassword || Boolean(draft.password)) &&
    Boolean(draft.database.trim()) &&
    Boolean(draft.table.trim())
  );
}
