/**
 * Gateway settings: authentication/provisioning settings, the running version
 * and the license status. Seeds 64600–64699.
 */
import type {
  AuthProvisioningSettings,
  CloudLinkStatusView,
  LicenseStatusView,
  UpdateStatus,
} from "@/types";
import { systemConfig, uiBootstrap, updateStatus } from "../shell";
import { ago, ahead, uuid } from "../time";
import { groupIds, groups } from "./admin";

export const authSettings: AuthProvisioningSettings = {
  oidcAutoCreateUsers: true,
  oidcDefaultGroupId: groupIds.viewer,
  oidcRequireVerifiedEmail: true,
  oauthExtendedCallbackCompatibility: false,
  mfaExistingSessionGracePeriodDays: 3,
  methods: { oidc: true, password: true, emailOtp: true, passkeyLogin: true },
  passwordPolicy: {
    minLength: 12,
    maxLength: 128,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSymbol: false,
  },
  smtp: {
    configured: true,
    host: "smtp.example.com",
    port: 587,
    tlsMode: "starttls",
    username: "gateway@example.com",
    passwordLast4: "k7Qe",
    senderName: "Northwind Opfield",
    senderEmail: "gateway@example.com",
    verifiedAt: ago(62, "d"),
  },
  oidc: {
    configured: true,
    issuer: "https://id.example.com/realms/northwind",
    clientId: "northwind-gateway",
    clientSecretLast4: "7c2f",
    redirectUri: "https://gateway.example.com/auth/callback",
    scopes: "openid profile email",
  },
  logging: {
    mode: "local",
    url: "http://clickhouse:8123",
    username: "gateway",
    passwordLast4: "a91d",
    database: "gateway_logs",
    table: "events",
    requestTimeoutMs: 10_000,
  },
  mcpServerEnabled: true,
  mcpExtendedCompatibility: false,
  webTransport: {
    tlsEnabled: true,
    restartRequired: false,
    directAccess: false,
    targetUrl: "https://gateway.example.com",
  },
  generalSettings: {
    publicUrl: systemConfig.publicUrl,
    updateChannel: "stable",
    hideExternalBranding: false,
    autoAssignCreatedResourcePermissions: true,
    fileUploadMaxBytes: systemConfig.fileUploadMaxBytes,
    fileOpenMaxBytes: systemConfig.fileOpenMaxBytes,
    grpcPublicTarget: systemConfig.grpcPublicTarget,
    grpcLocalIp: systemConfig.grpcLocalIp,
    relayAutoRecovery: true,
    relay: {
      dataLanes: 4,
      readChunkBytes: 65_536,
      assignmentSpread: { mode: "fixed", count: 2 },
      adaptiveAdmissionEnabled: true,
      proxyTargetPressurePercent: 70,
      databaseReservePercent: 15,
      hardPressurePercent: 90,
    },
    relayGrantTtlHours: 4,
    shutdown: {
      userRequestDrainSeconds: 30,
      structuredLogDrainSeconds: 5,
      finalizationTimeoutSeconds: 10,
    },
    features: {
      pkiEnabled: true,
      domainsEnabled: true,
      siemEnabled: true,
      inferenceEnabled: true,
    },
  },
  networkSecurity: {
    clientIpSource: "reverse_proxy",
    trustedProxyCidrs: ["203.0.113.0/28"],
    trustCloudflareHeaders: false,
  },
  outboundWebhookPolicy: {
    allowPrivateNetworks: false,
    allowedPrivateCidrs: ["10.20.0.0/16"],
  },
  currentRequestIp: {
    ipAddress: "198.51.100.24",
    remoteAddress: "203.0.113.2",
    source: "forwarded",
  },
  availableGroups: groups.map(({ id, name, isBuiltin }) => ({ id, name, isBuiltin })),
};

export const systemVersion = updateStatus as UpdateStatus;

const installationId = uuid(64601);

export const licenseStatus: LicenseStatusView = {
  status: "valid",
  plan: "enterprise",
  registrationStatus: "registered",
  paidLicenseStatus: "active",
  licensed: true,
  hasKey: true,
  keyLast4: "Q7XK",
  licenseName: "Northwind Enterprise",
  licenseMetadata: { organization: "Northwind" },
  installationId,
  installationName: "gateway.example.com",
  expiresAt: ahead(240, "d"),
  entitlementsVersion: uiBootstrap.license.entitlementsVersion,
  entitlements: uiBootstrap.license.entitlements,
  lastCheckedAt: ago(2, "h"),
  lastValidAt: ago(2, "h"),
  graceUntil: null,
  offlineGraceUntil: null,
  activeInstallationId: installationId,
  activeInstallationName: "Northwind production",
  errorMessage: null,
  serverUrl: "https://licensing.example.com",
};

/** Settings → General → Cloud: connected to a cloud account, remote management off. */
export const cloudStatus: CloudLinkStatusView = {
  state: "connected",
  portalUrl: "https://account.opfield.dev",
  accountEmail: "ops@example.com",
  connectedSince: ago(12, "d"),
  socket: { state: "online", since: ago(3, "h"), lastError: null },
  disconnectedAt: null,
  disconnectedReason: null,
  remoteManagement: { managed: false, enabled: false },
  recentRequests: [],
};
