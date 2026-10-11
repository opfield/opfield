/**
 * Maya's own account: MFA factors, browser sessions and AI usage. Seeds 64700–64799.
 */
import type { ApiToken, BrowserSession, OAuthAuthorization, User } from "@/types";
import type { InferenceSelfUsage, InferenceToken, InferenceUsageOverview } from "@/types/inference";
import { adminUser } from "../identity";
import { ago, agoMs, ahead, uuid } from "../time";

/**
 * The profile screen shows Maya with a local (password) account: Gateway MFA
 * (passkeys, authenticator app) only applies to local sign-in, so the Account
 * security panel is hidden for OIDC users.
 */
export const localAccountUser: User = { ...adminUser, oidcSubject: null, authMethod: "password" };

export const mfaStatus = {
  totpConfigured: true,
  passkeyCount: 1,
  recoveryCodeCount: 8,
  required: true,
};

export const passkeys = [
  {
    id: uuid(64701),
    name: "MacBook Pro Touch ID",
    lastUsedAt: ago(3, "h"),
    createdAt: ago(146, "d"),
  },
];

export const browserSessions: BrowserSession[] = [
  {
    id: uuid(64710),
    authMethod: "password",
    createdAt: agoMs(3, "h"),
    lastSeenAt: agoMs(1, "m"),
    expiresAt: Date.parse(ahead(7, "d")),
    ipAddress: "198.51.100.24",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    mfaSatisfiedAt: agoMs(3, "h"),
    isCurrent: true,
  },
  {
    id: uuid(64711),
    authMethod: "password",
    createdAt: agoMs(2, "d"),
    lastSeenAt: agoMs(5, "h"),
    expiresAt: Date.parse(ahead(5, "d")),
    ipAddress: "203.0.113.57",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    mfaSatisfiedAt: agoMs(2, "d"),
    isCurrent: false,
  },
  {
    id: uuid(64712),
    authMethod: "password",
    createdAt: agoMs(6, "d"),
    lastSeenAt: agoMs(1, "d"),
    expiresAt: Date.parse(ahead(1, "d")),
    ipAddress: "198.51.100.140",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    mfaSatisfiedAt: agoMs(6, "d"),
    isCurrent: false,
  },
];

export const inferenceSelfUsage: InferenceSelfUsage = {
  measuredAt: ago(30, "s"),
  enabled: true,
  api: { configured: false, percentage: 0, recoveryAt: ahead(1, "d") },
  subscription: {
    "5h": { configured: true, percentage: 18, recoveryAt: ahead(3, "h") },
    "7d": { configured: true, percentage: 42, recoveryAt: ahead(4, "d") },
    "30d": { configured: true, percentage: 27, recoveryAt: ahead(19, "d") },
  },
};

// Weekday-shaped activity over the last 30 days.
const dailyUsage = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(agoMs(29 - index, "d"));
  const weekday = date.getUTCDay();
  const base = weekday === 0 || weekday === 6 ? 4 : 22;
  const requests = base + ((index * 7) % 13);
  return {
    date: date.toISOString().slice(0, 10),
    requests,
    credits: Math.round(requests * 0.31 * 100) / 100,
    apiMicrodollars: requests * 1_180,
    tokens: requests * 5_200,
  };
});

const totals = dailyUsage.reduce(
  (sum, row) => ({
    requests: sum.requests + row.requests,
    credits: sum.credits + row.credits,
    apiMicrodollars: sum.apiMicrodollars + row.apiMicrodollars,
    tokens: sum.tokens + row.tokens,
  }),
  { requests: 0, credits: 0, apiMicrodollars: 0, tokens: 0 }
);

export const inferenceUsageOverview: InferenceUsageOverview = {
  windowDays: 30,
  requestTotals: [
    {
      status: "completed",
      requests: totals.requests - 6,
      credits: totals.credits.toFixed(2),
      apiMicrodollars: totals.apiMicrodollars,
      tokens: totals.tokens,
    },
    { status: "failed", requests: 6, credits: "0", apiMicrodollars: 0, tokens: 0 },
  ],
  ledgerTotals: [
    {
      budgetType: "subscription",
      credits: totals.credits.toFixed(2),
      apiMicrodollars: totals.apiMicrodollars,
      tokens: totals.tokens,
    },
  ],
  dailyUsage,
};

// ── Authorizations: API tokens, OAuth grants and inference tokens (seeds 65300–65399) ─

const tokenScopes = {
  deploy: ["docker:containers:view", "docker:containers:manage", "docker:images:pull"],
  readOnly: ["proxy:view", "nodes:details", "databases:view", "storage:view"],
  logs: ["logs:read"],
};

export const apiTokens: ApiToken[] = [
  {
    id: uuid(65301),
    name: "CI deploys (storefront)",
    tokenPrefix: "gw_9c1e",
    scopes: tokenScopes.deploy,
    lastUsedAt: ago(34, "m"),
    createdAt: ago(120, "d"),
  },
  {
    id: uuid(65302),
    name: "Grafana data source",
    tokenPrefix: "gw_41ab",
    scopes: tokenScopes.readOnly,
    lastUsedAt: ago(2, "m"),
    createdAt: ago(88, "d"),
  },
  {
    id: uuid(65303),
    name: "Log shipper",
    tokenPrefix: "gw_7f20",
    scopes: tokenScopes.logs,
    lastUsedAt: ago(40, "s"),
    createdAt: ago(61, "d"),
  },
  {
    id: uuid(65304),
    name: "Old backup script",
    tokenPrefix: "gw_0d93",
    scopes: tokenScopes.readOnly,
    lastUsedAt: ago(74, "d"),
    createdAt: ago(300, "d"),
  },
];

export const oauthAuthorizations: OAuthAuthorization[] = [
  {
    clientId: "gateway-cli",
    clientName: "Opfield CLI",
    clientUri: "https://gateway.example.com/docs/cli",
    logoUri: null,
    scopes: ["nodes:details", "proxy:view", "docker:containers:view"],
    resource: "https://gateway.example.com/api",
    resources: ["https://gateway.example.com/api"],
    activeAccessTokens: 1,
    activeRefreshTokens: 1,
    createdAt: ago(21, "d"),
    lastUsedAt: ago(3, "h"),
    expiresAt: ahead(9, "d"),
  },
  {
    clientId: "mcp-desktop",
    clientName: "Desktop assistant (MCP)",
    clientUri: null,
    logoUri: null,
    scopes: ["mcp:use", "proxy:view", "logs:read"],
    resource: "https://gateway.example.com/mcp",
    resources: ["https://gateway.example.com/mcp"],
    activeAccessTokens: 2,
    activeRefreshTokens: 1,
    createdAt: ago(6, "d"),
    lastUsedAt: ago(25, "m"),
    expiresAt: ahead(24, "d"),
  },
];

export const inferenceTokens: InferenceToken[] = [
  {
    id: uuid(65311),
    name: "Laptop (Codex)",
    tokenPrefix: "gwi_5b0e",
    status: "active",
    lastUsedAt: ago(12, "m"),
    revokedAt: null,
    createdAt: ago(30, "d"),
  },
  {
    id: uuid(65312),
    name: "Build agent",
    tokenPrefix: "gwi_c3a7",
    status: "active",
    lastUsedAt: ago(2, "d"),
    revokedAt: null,
    createdAt: ago(58, "d"),
  },
  {
    id: uuid(65313),
    name: "Old workstation",
    tokenPrefix: "gwi_1f64",
    status: "revoked",
    lastUsedAt: ago(40, "d"),
    revokedAt: ago(33, "d"),
    createdAt: ago(140, "d"),
  },
];
