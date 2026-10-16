import { ALERT_CATEGORY_IDS } from '@/modules/notifications/notification-catalog.js';
import type { AIToolDefinition } from './ai.types.js';

export const NOTIFICATION_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'list_alert_rules',
    description:
      'List notification alert rules. Returns id, name, enabled, type (threshold/event), category, severity, metric, operator, thresholdValue, eventPattern, resourceIds, webhookIds, cooldownSeconds. Categories include hosting VM/account, node, container, build, compose, proxy (routes: health events and request metrics such as the 5xx share), pages, opfield (the Opfield host, backend process, Postgres, Redis, stack containers and background jobs, plus relay and license), logging, integration, certificate, security, managed database types, managed_storage, app (app environment health, kill switch, shutdown, maintenance, 5xx share over its routes), backup (failed or missed scheduled backups), domain (DNS not pointing to Opfield), pki (internal CA and certificate expiry), inference (provider connections and the inference core), relay_pool (relays, the pool, its updates), and docker_availability (failover, failback, degraded or unavailable workloads). Creating or editing a rule needs view of what it watches. Use manage_notifications alert_categories for each category metrics, events, and template variables.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ALERT_CATEGORY_IDS,
          description: 'Filter by category',
        },
        type: { type: 'string', enum: ['threshold', 'event'] },
        enabled: { type: 'boolean', description: 'Filter by enabled/disabled' },
        search: { type: 'string', description: 'Search by rule name' },
        page: { type: 'number' },
        limit: { type: 'number', description: 'Items per page (default 50, max 100)' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:alerts:view',
    invalidateStores: [],
  },
  {
    name: 'get_alert_rule',
    description: 'Get detailed information about a specific alert rule by ID.',
    parameters: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Alert rule UUID' },
      },
      required: ['ruleId'],
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:alerts:view',
    invalidateStores: [],
  },
  {
    name: 'list_alerts',
    description:
      'List the alerts that fired: what is alerting now (status firing, the default) and the alert history (status resolved, kept 30 days; all for both). Newest first. Each alert has status, severity, its rule (ruleId, ruleName, ruleType, category, metric, eventPattern), the resource (resourceType, resourceId, resourceName), the message notified, firedAt, resolvedAt, durationSeconds and details (the values the rule saw). An event rule (node offline, container stopped, backup failed...) records each occurrence resolved at once, so it shows under resolved; a threshold or state rule stays firing until it resolves. Alerts fired before 2.12.3 have no resourceName or message. Same data as GET /api/notifications/alerts. Rules themselves: list_alert_rules.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['firing', 'resolved', 'all'],
          description: 'firing (default): alerting now; resolved: history; all: both',
        },
        ruleId: { type: 'string', description: 'Only the alerts of this alert rule UUID' },
        category: { type: 'string', enum: ALERT_CATEGORY_IDS, description: 'Only rules of this category' },
        severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
        resourceType: { type: 'string', description: 'Resource type of the alert, e.g. node, proxy, container' },
        resourceId: { type: 'string', description: 'Resource id (or container name) of the alert' },
        since: { type: 'string', description: 'ISO date-time: alerts fired at or after it' },
        until: { type: 'string', description: 'ISO date-time: alerts fired at or before it' },
        search: { type: 'string', description: 'Search rule name, resource name or id, and message' },
        page: { type: 'number' },
        limit: { type: 'number', description: 'Items per page (default 50, max 100)' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:alerts:view',
    invalidateStores: [],
  },
  {
    name: 'create_alert_rule',
    description:
      "Create a new notification alert rule. Threshold rules fire when a metric crosses a value for durationSeconds; event rules fire on events or states like node offline or an app environment failing. The metric or event must be one of the category's (manage_notifications alert_categories lists them). Example, a route 5xx share of at least 10% for one minute: category proxy, type threshold, metric error_5xx_percent, operator >=, thresholdValue 10, durationSeconds 60.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Alert name (e.g., "CPU High")' },
        type: { type: 'string', enum: ['threshold', 'event'], description: 'Rule type' },
        category: {
          type: 'string',
          enum: ALERT_CATEGORY_IDS,
          description: 'Resource category',
        },
        severity: { type: 'string', enum: ['info', 'warning', 'critical'], description: 'Alert severity' },
        metric: {
          type: 'string',
          description:
            'For threshold: a metric id of the category, e.g. cpu, memory, disk, managed_disk_promised_pct (node: share of the managed databases and storage disk promised to its instances, over 100 when oversubscribed), restarts_per_hour (container), error_5xx_percent, error_4xx_percent, requests_per_second, latency_p95_ms (proxy), error_5xx_percent (app), days_until_expiry (certificate, pki), hours_since_last_backup (backup), managed_disk_pct (managed Postgres and key-value)',
        },
        metricTarget: {
          type: 'string',
          description:
            'For threshold: optional sub-target. Node disk: "@data" watches every data disk of the node (each mount except Opfield disk images of managed databases, storage and volumes; each disk alerts on its own), "/" or another mount point watches that disk only, omitted watches every reported mount. Hosting account: the currency.',
        },
        operator: { type: 'string', enum: ['>', '>=', '<', '<='], description: 'For threshold: comparison operator' },
        thresholdValue: { type: 'number', description: 'For threshold: threshold value' },
        durationSeconds: {
          type: 'number',
          description: 'For threshold: observation window in seconds used for firing (0 = instant)',
        },
        fireThresholdPercent: {
          type: 'number',
          description:
            'For threshold: percent of probes in the fire window that must breach before firing (default 100)',
        },
        resolveAfterSeconds: {
          type: 'number',
          description: 'For threshold: observation window in seconds used for resolving (default 60)',
        },
        resolveThresholdPercent: {
          type: 'number',
          description:
            'For threshold: percent of probes in the resolve window that must be clear before resolving (default 100)',
        },
        eventPattern: {
          type: 'string',
          description:
            'For event: an event id of the category, e.g. offline (node), stopped (container), health.offline (proxy), health.failing or kill_switch.on (app), backup.failed (backup), dns.not_pointing (domain), provider.unavailable (inference), member.offline (relay_pool), failover.completed (docker_availability)',
        },
        resourceIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Scope to specific resources of the category (empty = all): node, route, certificate, database or domain ids, container names, app or app environment ids, database ids for backup rules',
        },
        messageTemplate: {
          type: 'string',
          description: 'Handlebars message template (e.g., "CPU at {{value}}% on {{resource.name}}")',
        },
        resolveMessageTemplate: {
          type: 'string',
          description:
            'Handlebars message sent when the alert resolves (e.g., "{{resource.name}} is back online after {{fired.duration}}"). Omit to use Opfield\'s resolve text for the rule; the firing message is never reused.',
        },
        webhookIds: { type: 'array', items: { type: 'string' }, description: 'Webhook IDs to deliver to' },
        cooldownSeconds: { type: 'number', description: 'Cooldown between repeated firings (default 900)' },
        enabled: { type: 'boolean', description: 'Whether the rule is active (default true)' },
      },
      required: ['name', 'type', 'category', 'severity', 'webhookIds'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:alerts:manage',
    invalidateStores: [],
  },
  {
    name: 'update_alert_rule',
    description: 'Update an existing alert rule. Only include fields to change.',
    parameters: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Alert rule UUID' },
        name: { type: 'string', description: 'New name' },
        enabled: { type: 'boolean', description: 'Enable/disable' },
        severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
        metric: { type: 'string' },
        metricTarget: {
          type: ['string', 'null'],
          description: 'Node disk: "@data" (every data disk), a mount point, or null (every reported mount)',
        },
        operator: { type: 'string', enum: ['>', '>=', '<', '<='] },
        thresholdValue: { type: 'number' },
        durationSeconds: { type: 'number' },
        fireThresholdPercent: { type: 'number' },
        resolveAfterSeconds: { type: 'number' },
        resolveThresholdPercent: { type: 'number' },
        eventPattern: { type: 'string' },
        resourceIds: { type: 'array', items: { type: 'string' } },
        messageTemplate: { type: 'string' },
        resolveMessageTemplate: {
          type: ['string', 'null'],
          description: "Message sent when the alert resolves; empty or null uses Opfield's resolve text",
        },
        webhookIds: { type: 'array', items: { type: 'string' } },
        cooldownSeconds: { type: 'number' },
      },
      required: ['ruleId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:alerts:manage',
    invalidateStores: [],
  },
  {
    name: 'delete_alert_rule',
    description: 'Delete a notification alert rule.',
    parameters: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Alert rule UUID' },
      },
      required: ['ruleId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:alerts:manage',
    invalidateStores: [],
  },
  {
    name: 'list_webhooks',
    description:
      'List notification webhooks. Returns id, name, url, method, enabled, templatePreset, headers. URL and headers are revealed only with notifications:webhooks:manage.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        enabled: { type: 'boolean' },
        page: { type: 'number' },
        limit: { type: 'number', description: 'Items per page (default 50, max 100)' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:webhooks:view',
    invalidateStores: [],
  },
  {
    name: 'create_webhook',
    description:
      'Create a notification webhook endpoint. Webhooks define where and how alert notifications are delivered (Discord, Slack, Telegram, or custom HTTP). Use template presets for quick setup.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Webhook name (e.g., "Discord Alerts")' },
        url: { type: 'string', description: 'HTTP URL to POST to' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'], description: 'HTTP method (default POST)' },
        templatePreset: {
          type: 'string',
          enum: ['discord', 'slack', 'telegram', 'json', 'plain'],
          description: 'Built-in template preset',
        },
        bodyTemplate: { type: 'string', description: 'Custom Handlebars body template (overrides preset)' },
        signingSecret: { type: 'string', description: 'HMAC-SHA256 signing secret (optional)' },
        signingHeader: { type: 'string', description: 'HMAC header name (default X-Signature-256)' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra HTTP headers sent with each delivery',
        },
        enabled: { type: 'boolean', description: 'Default true' },
      },
      required: ['name', 'url'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:webhooks:manage',
    invalidateStores: [],
  },
  {
    name: 'update_webhook',
    description: 'Update an existing webhook. Only include fields to change.',
    parameters: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'Webhook UUID' },
        name: { type: 'string' },
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'] },
        enabled: { type: 'boolean' },
        templatePreset: { type: ['string', 'null'] },
        bodyTemplate: { type: 'string' },
        signingSecret: { type: ['string', 'null'], description: 'New signing secret; null removes it' },
        signingHeader: { type: 'string' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Full replacement set of extra HTTP headers',
        },
      },
      required: ['webhookId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:webhooks:manage',
    invalidateStores: [],
  },
  {
    name: 'delete_webhook',
    description: 'Delete a notification webhook.',
    parameters: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'Webhook UUID' },
      },
      required: ['webhookId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'notifications:webhooks:manage',
    invalidateStores: [],
  },
  {
    name: 'test_webhook',
    description:
      'Send a test notification to a webhook to verify it works. Returns success status, HTTP status code, and any error.',
    parameters: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'Webhook UUID' },
      },
      required: ['webhookId'],
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:webhooks:manage',
    invalidateStores: [],
  },
  {
    name: 'list_webhook_deliveries',
    description:
      'List recent webhook delivery attempts. Returns delivery status, HTTP response code, timing, retry info. Use to diagnose delivery failures.',
    parameters: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'Filter by webhook UUID' },
        status: {
          type: 'string',
          enum: ['success', 'failed', 'retrying', 'pending', 'superseded'],
          description: 'Filter by delivery status; superseded = not sent (see the delivery error for why)',
        },
        eventType: { type: 'string', description: 'Filter by event type' },
        page: { type: 'number' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:webhooks:view',
    invalidateStores: [],
  },
  {
    name: 'get_delivery_stats',
    description: 'Get delivery statistics (total, success, failed, retrying counts). Optionally filter by webhook.',
    parameters: {
      type: 'object',
      properties: {
        webhookId: { type: 'string', description: 'Filter by webhook UUID' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:webhooks:view',
    invalidateStores: [],
  },
  {
    name: 'manage_notifications',
    description:
      'Read notification catalogs and details. Operations: alert_categories (metrics, events, template variables and the view scopes each alert category needs), alert_resources (what a relay_pool or docker_availability rule can be scoped to; pass category), webhook_get (one webhook; URL and headers need notifications:webhooks:manage), webhook_presets (built-in body templates), webhook_preview (render bodyTemplate with a sample event; needs notifications:webhooks:manage), delivery_get (one delivery attempt; payloads need notifications:webhooks:manage).',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'alert_categories',
            'alert_resources',
            'webhook_get',
            'webhook_presets',
            'webhook_preview',
            'delivery_get',
          ],
        },
        category: {
          type: 'string',
          enum: ['relay_pool', 'docker_availability'],
          description: 'Alert category for alert_resources',
        },
        webhookId: { type: 'string', description: 'Webhook UUID for webhook_get' },
        deliveryId: { type: 'string', description: 'Delivery UUID for delivery_get' },
        bodyTemplate: { type: 'string', description: 'Handlebars body template for webhook_preview' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'notifications:alerts:view',
    invalidateStores: [],
  },
  {
    name: 'list_siem_destinations',
    description:
      'List configured SIEM audit export destinations. Returns safe configuration metadata and delivery state; secrets are never returned.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Filter by enabled/disabled state' },
        search: { type: 'string', description: 'Filter by destination name' },
        page: { type: 'number' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'audit:siem:view',
    invalidateStores: [],
  },
  {
    name: 'get_siem_destination',
    description:
      'Get safe details and current delivery state for a SIEM audit export destination. The configured secret is never returned.',
    parameters: {
      type: 'object',
      properties: { destinationId: { type: 'string', description: 'SIEM destination UUID' } },
      required: ['destinationId'],
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'audit:siem:view',
    invalidateStores: [],
  },
  {
    name: 'create_siem_destination',
    description:
      'Create a SIEM audit export destination. The URL must be HTTPS without credentials, query parameters, or fragments. The bearer token, HMAC secret, or custom header value is encrypted at rest and never returned. This sends Opfield audit metadata, never full audit details.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Operator-facing destination name' },
        url: { type: 'string', description: 'HTTPS collector endpoint without query parameters' },
        authType: {
          type: 'string',
          enum: ['bearer', 'hmac_sha256', 'custom_header'],
          description: 'Authentication mechanism',
        },
        customHeaderName: {
          type: 'string',
          description: 'HTTP header field name for custom_header authentication only',
        },
        secret: {
          type: 'string',
          description: 'One-time bearer token, HMAC secret, or custom header value; never repeat it in responses',
        },
        enabled: { type: 'boolean', description: 'Start delivery immediately (default true)' },
      },
      required: ['name', 'url', 'authType', 'secret'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'audit:siem:manage',
    invalidateStores: [],
  },
  {
    name: 'update_siem_destination',
    description:
      'Update a SIEM destination. Include secret only to replace it. Changing authType requires a new secret. custom_header requires customHeaderName. Disabling pauses queued and retrying deliveries; re-enabling resumes them.',
    parameters: {
      type: 'object',
      properties: {
        destinationId: { type: 'string', description: 'SIEM destination UUID' },
        name: { type: 'string' },
        url: { type: 'string', description: 'HTTPS collector endpoint without query parameters' },
        authType: { type: 'string', enum: ['bearer', 'hmac_sha256', 'custom_header'] },
        customHeaderName: {
          type: 'string',
          description: 'HTTP header field name for custom_header authentication only',
        },
        secret: { type: 'string', description: 'One-time replacement secret; never repeat it in responses' },
        enabled: { type: 'boolean', description: 'Enable or pause delivery' },
      },
      required: ['destinationId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'audit:siem:manage',
    invalidateStores: [],
  },
  {
    name: 'delete_siem_destination',
    description:
      'Soft-delete a SIEM destination and discard any outstanding deliveries. Historical terminal delivery records remain until audit retention cleanup.',
    parameters: {
      type: 'object',
      properties: { destinationId: { type: 'string', description: 'SIEM destination UUID' } },
      required: ['destinationId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'audit:siem:manage',
    invalidateStores: [],
  },
  {
    name: 'test_siem_destination',
    description:
      'Send one synthetic SIEM test event to verify a destination. It creates no audit-log row and no queued delivery, and never exposes collector response bodies.',
    parameters: {
      type: 'object',
      properties: { destinationId: { type: 'string', description: 'SIEM destination UUID' } },
      required: ['destinationId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'audit:siem:manage',
    invalidateStores: [],
  },
  {
    name: 'list_siem_deliveries',
    description:
      'List SIEM audit-export delivery records and safe delivery diagnostics. Payloads are only available through get_siem_delivery and never include audit details or secrets.',
    parameters: {
      type: 'object',
      properties: {
        destinationId: { type: 'string', description: 'Filter by SIEM destination UUID' },
        status: {
          type: 'string',
          enum: ['queued', 'delivering', 'retrying', 'delivered', 'failed', 'paused', 'discarded'],
          description: 'Filter by delivery lifecycle state',
        },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'audit:siem:view',
    invalidateStores: [],
  },
  {
    name: 'get_siem_delivery',
    description:
      'Get a SIEM delivery record, including its frozen privacy-reduced event and safe response metadata. It never returns secrets, full audit details, or collector response bodies.',
    parameters: {
      type: 'object',
      properties: { deliveryId: { type: 'string', description: 'SIEM delivery UUID' } },
      required: ['deliveryId'],
    },
    destructive: false,
    category: 'Notifications',
    requiredScope: 'audit:siem:view',
    invalidateStores: [],
  },
  {
    name: 'requeue_siem_delivery',
    description:
      'Requeue one terminal failed SIEM delivery from attempt zero. It cannot requeue deliveries that were delivered, paused, or discarded.',
    parameters: {
      type: 'object',
      properties: { deliveryId: { type: 'string', description: 'Failed SIEM delivery UUID' } },
      required: ['deliveryId'],
    },
    destructive: true,
    category: 'Notifications',
    requiredScope: 'audit:siem:manage',
    invalidateStores: [],
  },
];

export const WEB_SEARCH_AI_TOOL: AIToolDefinition = {
  name: 'web_search',
  description:
    "Search the web for current information about PKI, certificates, protocols, or any topic. Use when the user asks about something you don't know or needs up-to-date information.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Max results (default 5, max 10)' },
    },
    required: ['query'],
  },
  destructive: false,
  category: 'Web Search',
  requiredScope: 'ai:workspace:use',
  invalidateStores: [],
};
