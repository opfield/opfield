// ── Notifications ──────────────────────────────────────────────────

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  type: "threshold" | "event";
  category:
    | "node"
    | "container"
    | "build"
    | "compose"
    | "proxy"
    | "opfield"
    | "logging"
    | "integration"
    | "certificate"
    | "security"
    | "pages"
    | "database_postgres"
    | "database_clickhouse"
    | "database_redis"
    | "managed_storage"
    | "hosting_vm"
    | "hosting_account"
    | "app"
    | "backup"
    | "domain"
    | "pki"
    | "inference"
    | "relay_pool"
    | "docker_availability";
  severity: "info" | "warning" | "critical";
  metric: string | null;
  metricTarget: string | null;
  operator: string | null;
  thresholdValue: number | null;
  durationSeconds: number;
  fireThresholdPercent: number;
  resolveAfterSeconds: number;
  resolveThresholdPercent: number;
  eventPattern: string | null;
  resourceIds: string[];
  messageTemplate: string | null;
  /** Sent when the alert resolves; null uses Opfield's resolve text for the rule. */
  resolveMessageTemplate: string | null;
  webhookIds: string[];
  cooldownSeconds: number;
  isBuiltin: boolean;
  /** Alert rule folder; null is ungrouped. Built-in rules never have one. */
  folderId?: string | null;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationWebhook {
  id: string;
  name: string;
  url: string;
  method: string;
  enabled: boolean;
  signingSecret: string | null;
  signingHeader: string | null;
  templatePreset: string | null;
  bodyTemplate: string | null;
  headers: Record<string, string>;
  /** Webhook folder; null is ungrouped. */
  folderId?: string | null;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  webhookName: string | null;
  eventType: string;
  severity: string;
  requestUrl: string;
  requestMethod: string;
  requestBody: string | null;
  requestBodyPreview?: string | null;
  requestBodyTruncated?: boolean;
  responseStatus: number | null;
  responseBody: string | null;
  responseBodyPreview?: string | null;
  responseBodyTruncated?: boolean;
  responseTimeMs: number | null;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  /** superseded: not sent, the alert resolved first (or another alert stands for it); `error` says why. */
  status: "pending" | "success" | "failed" | "retrying" | "superseded";
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface WebhookPreset {
  id: string;
  name: string;
  description: string;
  urlHint: string;
  defaultHeaders: Record<string, string>;
  bodyTemplate: string;
}

// ── SIEM audit export ──────────────────────────────────────────────

export type SiemAuthType = "bearer" | "hmac_sha256" | "custom_header";

export type SiemDeliveryStatus =
  | "queued"
  | "delivering"
  | "retrying"
  | "delivered"
  | "failed"
  | "paused"
  | "discarded";

export interface SiemDestination {
  id: string;
  name: string;
  url: string;
  authType: SiemAuthType;
  /** Header name is returned only for custom-header authentication. */
  customHeaderName: string | null;
  /** The plaintext secret is never returned. */
  secretConfigured: boolean;
  enabled: boolean;
  pendingDeliveries: number;
  lastDeliveryStatus: SiemDeliveryStatus | null;
  lastDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SiemAuditEvent {
  id: string;
  source: string;
  type: "dev.opfield.audit.v1";
  time: string;
  data: {
    action: string;
    actor: { id: string; email: string | null } | null;
    resource: { type: string; id: string | null };
    sourceIp: string | null;
  };
}

export interface SiemDelivery {
  id: string;
  destinationId: string;
  destinationName: string | null;
  destinationUrl: string | null;
  auditLogId: string;
  action?: string | null;
  payload?: SiemAuditEvent;
  status: SiemDeliveryStatus;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  responseStatus: number | null;
  responseTimeMs: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AlertCategoryDef {
  id: string;
  label: string;
  /** What the rule's scope picks, plural and lower case ("routes"). */
  resourceLabel?: string;
  /** False when the category has no resources to pick. */
  scopable?: boolean;
  /** View scopes an author needs for a rule on every resource of the category. */
  viewScopes?: string[];
  metrics: Array<{
    id: string;
    label: string;
    unit: string;
    defaultOperator: string;
    defaultValue: number;
    defaultDurationSeconds?: number;
    defaultResolveAfterSeconds?: number;
  }>;
  events: Array<{
    id: string;
    label: string;
    defaultSeverity: string;
    supportsThreshold?: boolean;
    /** A recovery state (back online): sent once when it begins, closes quietly, no resolve message. */
    recovery?: boolean;
  }>;
  variables: Array<{ name: string; description: string }>;
}
