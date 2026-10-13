import type { LicenseStatusView } from "@/types";
import type { SmtpDraft, SmtpPresetId } from "../settings/smtp-presets";

export type SetupStep =
  | "public-url"
  | "network"
  | "auth-methods"
  | "oidc-config"
  | "smtp-config"
  | "admin-auth"
  | "admin-details"
  | "logging"
  | "finish"
  | "license"
  | "ai-workspace";
export type PrimaryMethod = "oidc" | "password" | "email_otp";
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
  authMethod: PrimaryMethod | null;
  password: string;
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
  };
  logging: LoggingDraft & { passwordLast4: string | null };
  transport: { tlsEnabled: boolean };
}

export function getEnabledPrimaryMethods(methods: AuthMethodsDraft): PrimaryMethod[] {
  const enabled: PrimaryMethod[] = [];
  if (methods.oidc) enabled.push("oidc");
  if (methods.password) enabled.push("password");
  if (methods.emailOtp) enabled.push("email_otp");
  return enabled;
}

export function getSetupSteps(
  methods: AuthMethodsDraft,
  administratorCreated = false
): SetupStep[] {
  const enabledPrimaryMethods = getEnabledPrimaryMethods(methods);
  return [
    "public-url",
    "network",
    "auth-methods",
    ...(methods.oidc ? (["oidc-config"] as const) : []),
    ...(methods.password || methods.emailOtp ? (["smtp-config"] as const) : []),
    ...(!administratorCreated && enabledPrimaryMethods.length > 1 ? (["admin-auth"] as const) : []),
    ...(!administratorCreated ? (["admin-details"] as const) : []),
    "logging",
    "finish",
    "license",
    "ai-workspace",
  ];
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

export function isAdminDraftValid(draft: AdminDraft): boolean {
  return (
    draft.authMethod !== null &&
    Boolean(draft.name.trim()) &&
    isEmail(draft.email) &&
    (draft.authMethod !== "password" ||
      (draft.password.length >= 12 && draft.password.length <= 72))
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
