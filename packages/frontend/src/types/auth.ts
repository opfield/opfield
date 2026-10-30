import type { AIApprovalMode } from "@/lib/ai-approval-mode";

// User
export interface User {
  id: string;
  oidcSubject: string | null;
  authMethod?: "oidc" | "password" | "email_otp" | "demo_email_otp";
  email: string;
  name: string | null;
  avatarUrl: string | null;
  groupId: string;
  groupIds?: string[];
  groupNames?: string[];
  groupName: string;
  groupScopes?: string[];
  additionalScopes?: string[];
  scopes: string[];
  isBlocked: boolean;
  /** Admin user payloads: who blocked the account while it is blocked. */
  blockedBy?: "admin" | "opfield_account" | null;
  isDeleted?: boolean;
  aiApprovalMode?: AIApprovalMode;
  folderId?: string | null;
  sortOrder?: number;
  /** Admin user payloads: set once the user has signed in; null means never. */
  lastLoginAt?: string | null;
  /** Admin user payloads: when the one-time account invitation email was sent. */
  invitationSentAt?: string | null;
  impersonation?: {
    active: true;
    actor: {
      id: string;
      email: string;
      name: string | null;
    };
  };
}

export interface DeletedUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  deletedAt: string;
  deletedByUserId: string | null;
  deletedFromGroupId: string | null;
  originalGroupExists: boolean;
}

export interface BrowserSession {
  id: string;
  authMethod: "oidc" | "password" | "email_otp";
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ipAddress: string | null;
  userAgent: string | null;
  mfaSatisfiedAt: number | null;
  isCurrent: boolean;
}

// Permission Group
export interface PermissionGroup {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  parentId: string | null;
  folderId?: string | null;
  sortOrder?: number;
  scopes: string[];
  require2fa?: boolean;
  inheritedScopes?: string[];
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthProvisioningGroupOption {
  id: string;
  name: string;
  isBuiltin: boolean;
}

export interface AuthProvisioningSettings {
  oidcAutoCreateUsers: boolean;
  oidcDefaultGroupId: string;
  oidcRequireVerifiedEmail: boolean;
  oauthExtendedCallbackCompatibility: boolean;
  mfaExistingSessionGracePeriodDays: number;
  methods?: {
    oidc: boolean;
    password: boolean;
    emailOtp: boolean;
    passkeyLogin: boolean;
  };
  passwordPolicy?: {
    minLength: number;
    maxLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireDigit: boolean;
    requireSymbol: boolean;
  };
  smtp?: {
    configured: boolean;
    host: string | null;
    port: number | null;
    tlsMode: "starttls" | "tls" | null;
    username: string | null;
    passwordLast4: string | null;
    senderName: string | null;
    senderEmail: string | null;
    verifiedAt: string | null;
    /** cloud: sign-in emails go through Opfield Cloud email (then configured/verifiedAt describe it). */
    transport?: "smtp" | "cloud";
    /** Managed installations whose Opfield account set up cloud email; null elsewhere. */
    cloud?: {
      available: boolean;
      active: boolean;
      ownSmtp: boolean;
      from: string | null;
      limits: { month: number; day: number; hour: number } | null;
      since: string | null;
    } | null;
  };
  oidc?: {
    configured: boolean;
    issuer: string | null;
    clientId: string | null;
    clientSecretLast4: string | null;
    redirectUri: string | null;
    scopes: string;
    /** Name on the sign-in button; null shows "Sign in with SSO". */
    displayName?: string | null;
    /** The provider is the Opfield account the managed installation was provisioned with. */
    opfieldAccount?: boolean;
  };
  logging?: {
    mode: "disabled" | "local" | "external";
    url: string;
    username: string;
    passwordLast4: string | null;
    database: string;
    table: string;
    requestTimeoutMs: number;
  };
  mcpServerEnabled: boolean;
  mcpExtendedCompatibility: boolean;
  webTransport?: {
    tlsEnabled: boolean;
    restartRequired: boolean;
    directAccess: boolean;
    targetUrl: string | null;
  };
  generalSettings: {
    publicUrl: string | null;
    updateChannel: "stable" | "preview";
    hideExternalBranding?: boolean;
    autoAssignCreatedResourcePermissions?: boolean;
    sendInvitationOnUserCreate?: boolean;
    fileUploadMaxBytes: number;
    fileOpenMaxBytes: number;
    grpcPublicTarget: string | null;
    grpcLocalIp: string | null;
    relayAutoRecovery: boolean;
    relay?: {
      dataLanes: number;
      readChunkBytes: number;
      assignmentSpread: { mode: "fixed"; count: number } | { mode: "all" };
      adaptiveAdmissionEnabled: boolean;
      proxyTargetPressurePercent: number;
      databaseReservePercent: number;
      hardPressurePercent: number;
    };
    relayGrantTtlHours: number;
    relayPolicyLeaseHours: number;
    shutdown: {
      userRequestDrainSeconds: number;
      structuredLogDrainSeconds: number;
      finalizationTimeoutSeconds: number;
    };
    features: {
      pkiEnabled: boolean;
      domainsEnabled: boolean;
      siemEnabled: boolean;
      inferenceEnabled: boolean;
    };
  };
  networkSecurity: {
    clientIpSource: "auto" | "direct" | "reverse_proxy" | "cloudflare";
    trustedProxyCidrs: string[];
    trustCloudflareHeaders: boolean;
  };
  outboundWebhookPolicy: {
    allowPrivateNetworks: boolean;
    allowedPrivateCidrs: string[];
  };
  currentRequestIp: {
    ipAddress?: string;
    remoteAddress?: string;
    source: "remote" | "cloudflare" | "forwarded" | "real-ip" | "unknown";
    warning?: string;
  };
  availableGroups: AuthProvisioningGroupOption[];
  /** Managed cloud installation: the public URL and gRPC addresses belong to the cloud. */
  cloudManaged?: boolean;
  /** Managed only: the custom domain the Opfield account set; read-only here. */
  cloudPublicAlias?: {
    domain: string | null;
    state: "none" | "issuing" | "active" | "failed";
    error?: string;
    /** The installation's own address, which keeps working next to the custom domain. */
    baseUrl: string | null;
  } | null;
  /** Use Opfield account for sign-in, as Settings > Authentication > OIDC provider shows it. */
  opfieldAccountSignIn?: {
    /** Connected to Opfield Cloud: the action brings the provider back or asks the account for a client. */
    available: boolean;
    /** The cloud gave this installation a client: the action brings the provider back at once. */
    clientIssued: boolean;
    /** Asked the Opfield account for a client; waiting for it. */
    pendingRequest: { redirectUri: string; requestedAt: string } | null;
    /** The cloud link ended or switched accounts but the Opfield account provider stayed: no other admin could sign in. */
    detached: boolean;
  };
}

/** An Opfield account sign-in to a protected route that the console user confirms (or cancels). */
export interface AccessSignInConsent {
  /** The route that asks. */
  host: string;
  account: { email: string; name: string | null };
}

export interface OAuthConsentPreview {
  requestId: string;
  client: {
    id: string;
    name: string;
    uri: string | null;
    logoUri: string | null;
  };
  account: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
  };
  requestedScopes: string[];
  grantableScopes: string[];
  unavailableScopes: string[];
  manualApprovalScopes: string[];
  redirect: {
    uri: string;
    isExternal: boolean;
  };
  resource: string;
  resourceInfo: {
    resource: string;
    name: string;
    description: string;
  };
  expiresAt: string;
}

export interface OAuthAuthorization {
  /** One consent: its own tokens and scopes. A client can hold several. */
  id: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  scopes: string[];
  resource: string;
  resources: string[];
  activeAccessTokens: number;
  activeRefreshTokens: number;
  createdAt: string;
  lastUsedAt: string | null;
  /** When the grant really ends: its own expiry or that of its tokens, whichever comes first. */
  expiresAt: string | null;
  /** The expiry the owner set on the grant; null: none. */
  grantExpiresAt: string | null;
  /** Addresses or CIDR ranges every token of the grant works from; empty: any address. */
  allowedIps: string[];
}

/** Internal registry access of an API token: pull and push each "all" or a list of repositories. */
export type TokenRegistryAccess = Partial<Record<"pull" | "push", "all" | string[]>>;

export interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  registryAccess?: TokenRegistryAccess;
  /** Null: never expires. */
  expiresAt?: string | null;
  /** The expiry passed: refused, listed as Expired until housekeeping removes it. */
  expired?: boolean;
  /** Empty: any address. */
  allowedIps?: string[];
  lastUsedAt: string | null;
  createdAt: string;
}
