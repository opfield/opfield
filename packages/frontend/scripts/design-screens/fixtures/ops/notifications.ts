/**
 * Notifications: alert rules, their webhooks, webhook delivery history and the
 * SIEM audit export. Seeds 64000–64199.
 */
import type {
  AlertRule,
  NotificationWebhook,
  SiemDelivery,
  SiemDestination,
  WebhookDelivery,
} from "@/types";
import { databases, routes } from "../catalog";
import { edgeNode } from "../nodes";
import { ago, uuid } from "../time";

const opsWebhook = uuid(64001);
const oncallWebhook = uuid(64002);
const platformWebhook = uuid(64003);

export const webhooks: NotificationWebhook[] = [
  {
    id: opsWebhook,
    name: "#ops-alerts (Slack)",
    url: "https://hooks.example.com/services/T0NORTHWIND/B0OPSALERTS",
    method: "POST",
    enabled: true,
    signingSecret: null,
    signingHeader: null,
    templatePreset: "slack",
    bodyTemplate: null,
    headers: {},
    createdAt: ago(210, "d"),
    updatedAt: ago(34, "d"),
  },
  {
    id: oncallWebhook,
    name: "On-call pager",
    url: "https://pager.example.net/v2/enqueue",
    method: "POST",
    enabled: true,
    signingSecret: "configured",
    signingHeader: "X-Opfield-Signature",
    templatePreset: "json",
    bodyTemplate: null,
    headers: { "X-Routing-Key": "northwind-platform" },
    createdAt: ago(180, "d"),
    updatedAt: ago(12, "d"),
  },
  {
    id: platformWebhook,
    name: "Platform Discord",
    url: "https://chat.example.org/api/webhooks/platform",
    method: "POST",
    enabled: true,
    signingSecret: null,
    signingHeader: null,
    templatePreset: "discord",
    bodyTemplate: null,
    headers: {},
    createdAt: ago(96, "d"),
    updatedAt: ago(96, "d"),
  },
  {
    id: uuid(64004),
    name: "Legacy email relay",
    url: "https://mail-relay.example.net/hooks/opfield",
    method: "POST",
    enabled: false,
    signingSecret: null,
    signingHeader: null,
    templatePreset: "json",
    bodyTemplate: null,
    headers: {},
    createdAt: ago(320, "d"),
    updatedAt: ago(58, "d"),
  },
];

function rule(seed: number, overrides: Partial<AlertRule> & Pick<AlertRule, "name">): AlertRule {
  return {
    id: uuid(64010 + seed),
    enabled: true,
    type: "event",
    category: "node",
    severity: "warning",
    metric: null,
    metricTarget: null,
    operator: null,
    thresholdValue: null,
    durationSeconds: 0,
    fireThresholdPercent: 100,
    resolveAfterSeconds: 0,
    resolveThresholdPercent: 100,
    eventPattern: null,
    resourceIds: [],
    messageTemplate: null,
    resolveMessageTemplate: null,
    webhookIds: [opsWebhook],
    cooldownSeconds: 900,
    isBuiltin: false,
    createdAt: ago(200 - seed * 11, "d"),
    updatedAt: ago(30 - seed * 3, "d"),
    ...overrides,
  };
}

export const alertRules: AlertRule[] = [
  rule(1, {
    name: "Node offline",
    category: "node",
    severity: "critical",
    eventPattern: "offline",
    durationSeconds: 120,
    resolveAfterSeconds: 60,
    webhookIds: [opsWebhook, oncallWebhook],
    cooldownSeconds: 300,
    isBuiltin: true,
  }),
  rule(2, {
    name: "Certificate expiring soon",
    type: "threshold",
    category: "certificate",
    severity: "warning",
    metric: "days_until_expiry",
    operator: "<",
    thresholdValue: 14,
    durationSeconds: 0,
    resolveAfterSeconds: 0,
    cooldownSeconds: 86_400,
    isBuiltin: true,
  }),
  rule(3, {
    name: "Container restart loop",
    category: "container",
    severity: "critical",
    eventPattern: "exited",
    durationSeconds: 600,
    fireThresholdPercent: 60,
    resolveAfterSeconds: 300,
    webhookIds: [opsWebhook, oncallWebhook],
  }),
  rule(4, {
    name: "High error rate (production)",
    type: "threshold",
    category: "logging",
    severity: "critical",
    metric: "error_fatal_ratio_percent",
    operator: ">",
    thresholdValue: 5,
    durationSeconds: 300,
    fireThresholdPercent: 80,
    resolveAfterSeconds: 600,
    webhookIds: [opsWebhook, oncallWebhook, platformWebhook],
  }),
  rule(5, {
    name: "Edge CPU saturation",
    type: "threshold",
    category: "node",
    severity: "warning",
    metric: "cpu",
    operator: ">",
    thresholdValue: 85,
    durationSeconds: 600,
    fireThresholdPercent: 90,
    resolveAfterSeconds: 300,
    resourceIds: [edgeNode.id],
  }),
  rule(6, {
    name: "Root disk filling up",
    type: "threshold",
    category: "node",
    severity: "warning",
    metric: "disk",
    metricTarget: "/",
    operator: ">",
    thresholdValue: 85,
    durationSeconds: 900,
    resolveAfterSeconds: 900,
    webhookIds: [opsWebhook, platformWebhook],
  }),
  rule(7, {
    name: "Route health offline",
    category: "proxy",
    severity: "critical",
    eventPattern: "health.offline",
    durationSeconds: 180,
    resolveAfterSeconds: 120,
    resourceIds: [routes[0].id, routes[1].id, routes[2].id, routes[6].id],
    webhookIds: [opsWebhook, oncallWebhook],
  }),
  rule(8, {
    name: "Orders DB unreachable",
    category: "database_postgres",
    severity: "critical",
    eventPattern: "health.offline",
    durationSeconds: 120,
    resolveAfterSeconds: 60,
    resourceIds: [databases[0].id],
    webhookIds: [oncallWebhook],
  }),
  rule(9, {
    name: "Certificate renewal failed",
    category: "certificate",
    severity: "critical",
    eventPattern: "renewal_failed",
    webhookIds: [opsWebhook, platformWebhook],
  }),
  rule(10, {
    name: "Image build succeeded",
    enabled: false,
    category: "build",
    severity: "info",
    eventPattern: "succeeded",
    webhookIds: [platformWebhook],
    cooldownSeconds: 0,
  }),
];

function delivery(
  seed: number,
  overrides: Partial<WebhookDelivery> &
    Pick<WebhookDelivery, "webhookId" | "eventType" | "severity" | "createdAt">
): WebhookDelivery {
  const hook = webhooks.find((item) => item.id === overrides.webhookId) ?? webhooks[0];
  return {
    id: uuid(64100 + seed),
    webhookName: hook.name,
    requestUrl: hook.url,
    requestMethod: "POST",
    requestBody: null,
    responseStatus: 200,
    responseBody: "ok",
    responseTimeMs: 180 + ((seed * 37) % 240),
    attempt: 1,
    maxAttempts: 5,
    nextRetryAt: null,
    status: "success",
    error: null,
    completedAt: overrides.createdAt,
    ...overrides,
  };
}

export const deliveries: WebhookDelivery[] = [
  delivery(1, {
    webhookId: opsWebhook,
    eventType: "certificate.days_until_expiry",
    severity: "warning",
    createdAt: ago(18, "m"),
  }),
  delivery(2, {
    webhookId: opsWebhook,
    eventType: "proxy.health.degraded",
    severity: "warning",
    createdAt: ago(52, "m"),
  }),
  delivery(3, {
    webhookId: oncallWebhook,
    eventType: "proxy.health.offline",
    severity: "critical",
    createdAt: ago(3, "h"),
    responseStatus: 202,
    responseBody: '{"status":"accepted"}',
  }),
  delivery(4, {
    webhookId: opsWebhook,
    eventType: "proxy.health.offline",
    severity: "critical",
    createdAt: ago(3, "h"),
  }),
  delivery(5, {
    webhookId: platformWebhook,
    eventType: "container.exited",
    severity: "critical",
    createdAt: ago(5, "h"),
    status: "retrying",
    attempt: 2,
    responseStatus: 503,
    responseBody: "upstream unavailable",
    nextRetryAt: ago(-4, "m"),
    error: "HTTP 503",
    completedAt: null,
  }),
  delivery(6, {
    webhookId: opsWebhook,
    eventType: "container.exited",
    severity: "critical",
    createdAt: ago(5, "h"),
  }),
  delivery(7, {
    webhookId: opsWebhook,
    eventType: "node.cpu",
    severity: "warning",
    createdAt: ago(9, "h"),
  }),
  delivery(8, {
    webhookId: oncallWebhook,
    eventType: "logging.error_fatal_ratio_percent",
    severity: "critical",
    createdAt: ago(21, "h"),
    responseStatus: 202,
    responseBody: '{"status":"accepted"}',
  }),
  delivery(9, {
    webhookId: opsWebhook,
    eventType: "certificate.renewed",
    severity: "info",
    createdAt: ago(1, "d"),
  }),
  delivery(10, {
    webhookId: opsWebhook,
    eventType: "node.online",
    severity: "info",
    createdAt: ago(2, "d"),
  }),
];

export const siemDestinations: SiemDestination[] = [
  {
    id: uuid(64150),
    name: "Security Operations",
    url: "https://siem.example.com/ingest/opfield-audit",
    authType: "hmac_sha256",
    customHeaderName: null,
    secretConfigured: true,
    enabled: true,
    pendingDeliveries: 0,
    lastDeliveryStatus: "delivered",
    lastDeliveryAt: ago(4, "m"),
    createdAt: ago(120, "d"),
    updatedAt: ago(40, "d"),
  },
  {
    id: uuid(64151),
    name: "Compliance archive",
    url: "https://archive.example.net/v1/events",
    authType: "bearer",
    customHeaderName: null,
    secretConfigured: true,
    enabled: true,
    pendingDeliveries: 3,
    lastDeliveryStatus: "retrying",
    lastDeliveryAt: ago(9, "m"),
    createdAt: ago(75, "d"),
    updatedAt: ago(75, "d"),
  },
  {
    id: uuid(64152),
    name: "Partner audit feed",
    url: "https://audit.partner.example.org/opfield",
    authType: "custom_header",
    customHeaderName: "X-Audit-Key",
    secretConfigured: true,
    enabled: false,
    pendingDeliveries: 0,
    lastDeliveryStatus: "delivered",
    lastDeliveryAt: ago(12, "d"),
    createdAt: ago(60, "d"),
    updatedAt: ago(12, "d"),
  },
];

type SiemSpec = [
  action: string,
  minutes: number,
  destination: number,
  status: SiemDelivery["status"],
  responseStatus: number | null,
];

const SIEM_DELIVERIES: SiemSpec[] = [
  ["auth.login", 4, 0, "delivered", 204],
  ["auth.login", 4, 1, "delivered", 202],
  ["proxy.update", 9, 1, "retrying", 503],
  ["proxy.update", 9, 0, "delivered", 204],
  ["docker.container.restart", 26, 0, "delivered", 204],
  ["docker.container.restart", 26, 1, "delivered", 202],
  ["database.backup.run", 71, 0, "delivered", 204],
  ["admin.user.update", 118, 0, "delivered", 204],
  ["ssl.cert.renew", 160, 0, "delivered", 204],
  ["ssl.cert.renew", 160, 1, "delivered", 202],
];

export const siemDeliveries: SiemDelivery[] = SIEM_DELIVERIES.map(
  ([action, minutes, destinationIndex, status, responseStatus], index) => {
    const destination = siemDestinations[destinationIndex];
    const retrying = status === "retrying";
    return {
      id: uuid(64160 + index),
      destinationId: destination.id,
      destinationName: destination.name,
      destinationUrl: destination.url,
      auditLogId: uuid(64180 + index),
      action,
      status,
      attempt: retrying ? 3 : 1,
      maxAttempts: 8,
      nextRetryAt: retrying ? ago(-2, "m") : null,
      responseStatus,
      responseTimeMs: retrying ? 10_000 : 90 + index * 17,
      error: retrying ? "HTTP 503 Service Unavailable" : null,
      createdAt: ago(minutes, "m"),
      completedAt: retrying ? null : ago(minutes, "m"),
    };
  }
);

export function page<T>(data: T[], limit = 100) {
  return { data, total: data.length, page: 1, limit, totalPages: 1 };
}
