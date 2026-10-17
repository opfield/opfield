/**
 * A trimmed copy of the server's alert category catalog (node, container,
 * route, certificate, database and logging) and the webhook body presets, so
 * the alert and webhook dialogs fill their pickers.
 */
import type { AlertCategoryDef, WebhookPreset } from "@/types";

const hostVariables = [
  { name: "resource.name", description: "Resource display name" },
  { name: "severity", description: "Alert severity" },
  { name: "value", description: "Observed metric value" },
  { name: "threshold", description: "Configured threshold" },
];

export const alertCategories: AlertCategoryDef[] = [
  {
    id: "node",
    label: "Node",
    metrics: [
      { id: "cpu", label: "CPU Usage (%)", unit: "%", defaultOperator: ">", defaultValue: 90 },
      {
        id: "memory",
        label: "Memory Usage (%)",
        unit: "%",
        defaultOperator: ">",
        defaultValue: 90,
      },
      { id: "disk", label: "Disk Usage (%)", unit: "%", defaultOperator: ">", defaultValue: 85 },
    ],
    events: [
      {
        id: "offline",
        label: "Node Offline",
        defaultSeverity: "critical",
        supportsThreshold: true,
      },
      { id: "online", label: "Node Online", defaultSeverity: "info", supportsThreshold: true },
    ],
    variables: hostVariables,
  },
  {
    id: "container",
    label: "Container",
    metrics: [
      { id: "cpu", label: "CPU Usage (%)", unit: "%", defaultOperator: ">", defaultValue: 90 },
      {
        id: "memory",
        label: "Memory Usage (%)",
        unit: "%",
        defaultOperator: ">",
        defaultValue: 90,
      },
      {
        id: "log_size",
        label: "Log Size (MB)",
        unit: "MB",
        defaultOperator: ">",
        defaultValue: 1024,
      },
    ],
    events: [
      {
        id: "stopped",
        label: "Container Stopped",
        defaultSeverity: "warning",
        supportsThreshold: true,
      },
      {
        id: "exited",
        label: "Container Exited",
        defaultSeverity: "warning",
        supportsThreshold: true,
      },
      {
        id: "health.offline",
        label: "Health Offline",
        defaultSeverity: "critical",
        supportsThreshold: true,
      },
      {
        id: "deployment.failed",
        label: "Deployment Failed",
        defaultSeverity: "critical",
        supportsThreshold: true,
      },
    ],
    variables: hostVariables,
  },
  {
    id: "proxy",
    label: "Proxy Host",
    metrics: [],
    events: [
      {
        id: "health.offline",
        label: "Health Offline",
        defaultSeverity: "critical",
        supportsThreshold: true,
      },
      {
        id: "health.degraded",
        label: "Health Degraded",
        defaultSeverity: "warning",
        supportsThreshold: true,
      },
      {
        id: "maintenance.active",
        label: "Maintenance Active",
        defaultSeverity: "warning",
        supportsThreshold: true,
      },
    ],
    variables: hostVariables,
  },
  {
    id: "certificate",
    label: "Certificate",
    metrics: [
      {
        id: "days_until_expiry",
        label: "Days Until Expiry",
        unit: "days",
        defaultOperator: "<",
        defaultValue: 14,
      },
    ],
    events: [
      { id: "renewed", label: "Certificate Renewed", defaultSeverity: "info" },
      { id: "renewal_failed", label: "Renewal Failed", defaultSeverity: "critical" },
    ],
    variables: hostVariables,
  },
  {
    id: "database_postgres",
    label: "PostgreSQL",
    metrics: [
      {
        id: "latency_ms",
        label: "Latency (ms)",
        unit: "ms",
        defaultOperator: ">",
        defaultValue: 500,
      },
      {
        id: "total_connections_pct",
        label: "Connections (%)",
        unit: "%",
        defaultOperator: ">",
        defaultValue: 80,
      },
    ],
    events: [
      {
        id: "health.offline",
        label: "Health Offline",
        defaultSeverity: "critical",
        supportsThreshold: true,
      },
      {
        id: "health.degraded",
        label: "Health Degraded",
        defaultSeverity: "warning",
        supportsThreshold: true,
      },
    ],
    variables: hostVariables,
  },
  {
    id: "logging",
    label: "Logging",
    metrics: [
      {
        id: "error_fatal_ratio_percent",
        label: "Error + fatal ratio (%)",
        unit: "%",
        defaultOperator: ">",
        defaultValue: 5,
      },
    ],
    events: [],
    variables: hostVariables,
  },
];

const template = (text: string) => JSON.stringify({ text }, null, 2);

export const webhookPresets: WebhookPreset[] = [
  {
    id: "slack",
    name: "Slack",
    description: "Block Kit message via Slack incoming webhook",
    urlHint: "https://hooks.example.com/services/...",
    defaultHeaders: {},
    bodyTemplate: template("{{severity}}: {{title}}"),
  },
  {
    id: "discord",
    name: "Discord",
    description: "Rich embed notification via Discord webhook URL",
    urlHint: "https://chat.example.org/api/webhooks/...",
    defaultHeaders: {},
    bodyTemplate: template("{{severity}}: {{title}}"),
  },
  {
    id: "telegram",
    name: "Telegram",
    description: "Send message via Telegram Bot API.",
    urlHint: "https://bot.example.net/bot<YOUR_BOT_TOKEN>/sendMessage",
    defaultHeaders: {},
    bodyTemplate: template("{{title}}"),
  },
  {
    id: "json",
    name: "JSON",
    description: "Raw alert payload as JSON",
    urlHint: "https://example.com/hooks/opfield",
    defaultHeaders: { "Content-Type": "application/json" },
    bodyTemplate: "{{json}}",
  },
];
