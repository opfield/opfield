/**
 * Handlebars template engine and built-in presets for webhook notifications.
 */

import Handlebars from 'handlebars';
import { SEVERITY_COLOR, SEVERITY_EMOJI, type Severity } from './notification.constants.js';

// ── Handlebars Helpers ────────────────────────────────────────────────

const hbs = Handlebars.create();

hbs.registerHelper('eq', (a, b) => a === b);
hbs.registerHelper('ne', (a, b) => a !== b);
hbs.registerHelper('gt', (a, b) => a > b);
hbs.registerHelper('lt', (a, b) => a < b);
hbs.registerHelper('gte', (a, b) => a >= b);
hbs.registerHelper('lte', (a, b) => a <= b);
hbs.registerHelper('and', (a, b) => a && b);
hbs.registerHelper('or', (a, b) => a || b);
hbs.registerHelper('not', (a) => !a);
hbs.registerHelper('json', (obj) => JSON.stringify(obj));
hbs.registerHelper('uppercase', (str) =>
  typeof str === 'string' || str instanceof String ? String(str).toUpperCase() : str
);
hbs.registerHelper('lowercase', (str) =>
  typeof str === 'string' || str instanceof String ? String(str).toLowerCase() : str
);
hbs.registerHelper('truncate', (str, len) => {
  if (typeof str !== 'string' && !(str instanceof String)) return str;
  const value = String(str);
  const n = typeof len === 'number' ? len : 50;
  return value.length > n ? `${value.slice(0, n)}...` : value;
});
hbs.registerHelper('default', (value, defaultValue) => value ?? defaultValue);
hbs.registerHelper('coalesce', (...args) => {
  const values = args.slice(0, -1);
  return values.find((value) => value !== null && value !== undefined && String(value) !== '') ?? null;
});
hbs.registerHelper('join', (arr, sep) => (Array.isArray(arr) ? arr.join(typeof sep === 'string' ? sep : ', ') : arr));
hbs.registerHelper('round', (value, decimals) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (Number.isNaN(n)) return value;
  const d = typeof decimals === 'number' ? decimals : 0;
  return Number(n.toFixed(d));
});
hbs.registerHelper('math', (a, op, b) => {
  const x = Number(a),
    y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return a;
  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      return y !== 0 ? x / y : 0;
    case '%':
      return y !== 0 ? x % y : 0;
    default:
      return x;
  }
});
hbs.registerHelper('percent', (value, total) => {
  const v = Number(value),
    t = Number(total);
  if (Number.isNaN(v) || Number.isNaN(t) || t === 0) return 0;
  return Number(((v / t) * 100).toFixed(1));
});
/** "45s", "3m 37s", "1h 9m": how long an alert lasted, as resolve texts and {{fired.duration}} show it. */
export function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
hbs.registerHelper('formatDuration', (seconds) => {
  // {{fired.duration}} is already formatted; its seconds stay readable as fired.duration.seconds.
  const raw = seconds && typeof seconds === 'object' && 'seconds' in seconds ? seconds.seconds : seconds;
  const s = Number(raw);
  if (Number.isNaN(s) || s < 0) return String(seconds);
  return formatDurationSeconds(s);
});
hbs.registerHelper('timeago', (timestamp) => {
  const d = typeof timestamp === 'string' ? new Date(timestamp) : timestamp instanceof Date ? timestamp : null;
  if (!d || Number.isNaN(d.getTime())) return String(timestamp);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
});
hbs.registerHelper('dateformat', (timestamp, format) => {
  const d = typeof timestamp === 'string' ? new Date(timestamp) : timestamp instanceof Date ? timestamp : null;
  if (!d || Number.isNaN(d.getTime())) return String(timestamp);
  const fmt = typeof format === 'string' ? format : 'YYYY-MM-DD HH:mm';
  const pad = (n: number) => String(n).padStart(2, '0');
  return fmt
    .replace('YYYY', String(d.getFullYear()))
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()))
    .replace('ss', pad(d.getSeconds()));
});
hbs.registerHelper('pluralize', (count, singular, plural) => {
  const n = Number(count);
  const p = typeof plural === 'string' ? plural : `${singular}s`;
  return n === 1 ? singular : p;
});

// ── Template Compilation ──────────────────────────────────────────────

// JSON-escape helper — use in JSON templates: {{jsonescape resource.name}}
hbs.registerHelper('jsonescape', (str) => {
  if (typeof str !== 'string' && !(str instanceof String)) return str;
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
});

/**
 * Compile and render a Handlebars template with the given context.
 * Returns the rendered string, or a fallback JSON on compilation error.
 */
export function renderTemplate(template: string, context: object): string {
  try {
    const compiled = hbs.compile(template, { noEscape: true });
    return compiled(context);
  } catch {
    // Fallback: raw JSON of the context so the delivery still has useful data
    return JSON.stringify(context);
  }
}

// ── Template Context Builder ──────────────────────────────────────────

type SeverityTemplateValue = string & { emoji: string; color: number };
/** Renders as "3m 37s"; JSON keeps the number of seconds, and .seconds reads it in a template. */
type DurationTemplateValue = string & { seconds: number };

export interface NotificationTemplateResource {
  type: string;
  id: string | null;
  key: string;
  name: string;
}

export interface NotificationTemplateContext {
  notification: {
    type: string;
    title: string;
    message: string;
    timestamp: string;
  };
  alert: {
    id: string;
    name: string;
    status: 'firing' | 'resolved';
    severity: SeverityTemplateValue;
  };
  resource: NotificationTemplateResource;
  metric: {
    name: string | null;
    value: number | null;
    threshold: number | null;
    operator: string | null;
    duration: number | null;
  };
  node: {
    id: string | null;
    name: string | null;
  };
  health: {
    status: string | null;
  };
  certificate: {
    days_until_expiry: number | null;
    expiry_date: string | null;
  };
  state: {
    current: string | null;
  };
  event: {
    name: string | null;
  };
  operation: {
    kind: string | null;
    phase: string | null;
    trigger: string | null;
  };
  failure: {
    code: string | null;
  };
  details: Record<string, string | number | boolean | null>;
  fired: {
    at: string | null;
    duration: DurationTemplateValue | null;
  };
  resolution: {
    reason: string | null;
  };
  opfield: {
    url: string;
  };
}

export type NotificationTemplateContextInput = {
  notification?: Partial<NotificationTemplateContext['notification']>;
  alert: {
    id: string;
    name: string;
    status: 'firing' | 'resolved';
    severity: Severity;
  };
  resource: NotificationTemplateResource;
  metric?: Partial<NotificationTemplateContext['metric']>;
  node?: Partial<NotificationTemplateContext['node']>;
  health?: Partial<NotificationTemplateContext['health']>;
  certificate?: Partial<NotificationTemplateContext['certificate']>;
  state?: Partial<NotificationTemplateContext['state']>;
  event?: Partial<NotificationTemplateContext['event']>;
  operation?: Partial<NotificationTemplateContext['operation']>;
  failure?: Partial<NotificationTemplateContext['failure']>;
  details?: Record<string, string | number | boolean | null>;
  /** duration: seconds the alert lasted. */
  fired?: { at?: string | null; duration?: number | null };
  resolution?: Partial<NotificationTemplateContext['resolution']>;
  opfield?: Partial<NotificationTemplateContext['opfield']>;
};

export interface NotificationEvent {
  type: string;
  title: string;
  message: string;
  severity: Severity;
  resource: NotificationTemplateResource;
  context: NotificationTemplateContext;
  timestamp: string;
}

function buildSeverityTemplateValue(severity: Severity): SeverityTemplateValue {
  const value = Object.assign(new String(severity), {
    emoji: SEVERITY_EMOJI[severity],
    color: SEVERITY_COLOR[severity],
    toJSON() {
      return { value: String(this), emoji: this.emoji, color: this.color };
    },
  });
  return value as unknown as SeverityTemplateValue;
}

function buildDurationTemplateValue(seconds: unknown): DurationTemplateValue | null {
  const raw = seconds && typeof seconds === 'object' && 'seconds' in seconds ? seconds.seconds : seconds;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  const value = Object.assign(new String(formatDurationSeconds(raw)), {
    seconds: raw,
    toJSON() {
      return raw;
    },
  });
  return value as unknown as DurationTemplateValue;
}

export function buildNotificationTemplateContext(input: NotificationTemplateContextInput): NotificationTemplateContext {
  const timestamp = input.notification?.timestamp ?? new Date().toISOString();
  const severity = buildSeverityTemplateValue(input.alert.severity);
  return {
    notification: {
      type: input.notification?.type ?? '',
      title: input.notification?.title ?? input.alert.name,
      message: input.notification?.message ?? '',
      timestamp,
    },
    alert: {
      id: input.alert.id,
      name: input.alert.name,
      status: input.alert.status,
      severity,
    },
    resource: input.resource,
    metric: {
      name: input.metric?.name ?? null,
      value: input.metric?.value ?? null,
      threshold: input.metric?.threshold ?? null,
      operator: input.metric?.operator ?? null,
      duration: input.metric?.duration ?? null,
    },
    node: {
      id: input.node?.id ?? null,
      name: input.node?.name ?? null,
    },
    health: {
      status: input.health?.status ?? null,
    },
    certificate: {
      days_until_expiry: input.certificate?.days_until_expiry ?? null,
      expiry_date: input.certificate?.expiry_date ?? null,
    },
    state: {
      current: input.state?.current ?? null,
    },
    event: {
      name: input.event?.name ?? null,
    },
    operation: {
      kind: input.operation?.kind ?? null,
      phase: input.operation?.phase ?? null,
      trigger: input.operation?.trigger ?? null,
    },
    failure: {
      code: input.failure?.code ?? null,
    },
    details: input.details ?? {},
    fired: {
      at: input.fired?.at ?? null,
      duration: buildDurationTemplateValue(input.fired?.duration),
    },
    resolution: {
      reason: input.resolution?.reason ?? null,
    },
    opfield: {
      url: input.opfield?.url ?? '',
    },
  };
}

/** Build the full template context from a notification event + the Opfield URL */
export function buildTemplateContext(event: NotificationEvent, opfieldUrl?: string): NotificationTemplateContext {
  return {
    ...event.context,
    // Events queued before 2.12.1 carry no `opfield` key; the dispatcher always passes the URL.
    opfield: { url: opfieldUrl ?? event.context.opfield?.url ?? '' },
  };
}

// ── Presets ────────────────────────────────────────────────────────────

export interface TemplatePreset {
  id: string;
  name: string;
  description: string;
  urlHint: string;
  defaultHeaders: Record<string, string>;
  bodyTemplate: string;
}

export const TEMPLATE_PRESETS: TemplatePreset[] = [
  {
    id: 'discord',
    name: 'Discord',
    description: 'Rich embed notification via Discord webhook URL',
    urlHint: 'https://discord.com/api/webhooks/...',
    defaultHeaders: { 'Content-Type': 'application/json' },
    bodyTemplate: `{
  "embeds": [{
    "title": "{{alert.severity.emoji}} {{notification.title}}",
    "description": "{{notification.message}}",
    "color": {{alert.severity.color}},
    "fields": [
      {"name": "Resource", "value": "{{resource.type}}/{{resource.name}}", "inline": true},
      {"name": "Severity", "value": "{{uppercase alert.severity}}", "inline": true}
    ],
    "timestamp": "{{notification.timestamp}}"
  }]
}`,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Block Kit message via Slack incoming webhook',
    urlHint: 'https://hooks.slack.com/services/...',
    defaultHeaders: { 'Content-Type': 'application/json' },
    bodyTemplate: `{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "{{alert.severity.emoji}} *[{{uppercase alert.severity}}] {{notification.title}}*\\n{{notification.message}}"
      }
    },
    {
      "type": "context",
      "elements": [
        {"type": "mrkdwn", "text": "*Resource:* {{resource.type}}/{{resource.name}}"},
        {"type": "mrkdwn", "text": "*Time:* {{notification.timestamp}}"}
      ]
    }
  ]
}`,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Send message via Telegram Bot API. Set your bot token in the URL and chat_id in the template.',
    urlHint: 'https://api.telegram.org/bot<YOUR_BOT_TOKEN>/sendMessage',
    defaultHeaders: { 'Content-Type': 'application/json' },
    bodyTemplate: `{
  "chat_id": "YOUR_CHAT_ID",
  "text": "{{alert.severity.emoji}} *[{{uppercase alert.severity}}] {{notification.title}}*\\n\\n{{notification.message}}\\n\\n_Resource:_ {{resource.type}}/{{resource.name}}\\n_Time:_ {{notification.timestamp}}",
  "parse_mode": "Markdown",
  "disable_web_page_preview": true
}`,
  },
  {
    id: 'json',
    name: 'JSON',
    description: 'Structured JSON payload suitable for any webhook receiver',
    urlHint: 'https://your-endpoint.example.com/webhook',
    defaultHeaders: { 'Content-Type': 'application/json' },
    bodyTemplate: `{
  "notification": {{{json notification}}},
  "alert": {{{json alert}}},
  "resource": {{{json resource}}},
  "metric": {{{json metric}}},
  "node": {{{json node}}},
  "health": {{{json health}}},
  "certificate": {{{json certificate}}},
  "state": {{{json state}}},
  "event": {{{json event}}},
  "fired": {{{json fired}}},
  "resolution": {{{json resolution}}},
  "opfield": {{{json opfield}}}
}`,
  },
  {
    id: 'plain',
    name: 'Plain Text',
    description: 'Simple text message, suitable for generic HTTP receivers',
    urlHint: 'https://your-endpoint.example.com/webhook',
    defaultHeaders: { 'Content-Type': 'text/plain' },
    bodyTemplate: `[{{uppercase alert.severity}}] {{notification.title}}
{{notification.message}}
Resource: {{resource.type}}/{{resource.name}}
Time: {{notification.timestamp}}`,
  },
];

export const PRESET_MAP = new Map(TEMPLATE_PRESETS.map((p) => [p.id, p]));

// ── Sample Event for Testing ──────────────────────────────────────────

export function buildSampleEvent(): NotificationEvent {
  const timestamp = new Date().toISOString();
  const context = buildNotificationTemplateContext({
    notification: {
      type: 'alert.fired',
      title: 'CPU High on docker-01',
      message: 'CPU usage has exceeded 90% for more than 5 minutes on node docker-01.',
      timestamp,
    },
    alert: {
      id: 'rule-cpu-high',
      name: 'CPU High',
      status: 'firing',
      severity: 'warning',
    },
    resource: {
      type: 'node',
      id: '00000000-0000-0000-0000-000000000001',
      key: '00000000-0000-0000-0000-000000000001',
      name: 'docker-01',
    },
    metric: {
      name: 'cpu',
      value: 92.5,
      threshold: 90,
      operator: '>',
      duration: 300,
    },
    node: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'docker-01',
    },
    fired: {
      at: timestamp,
      duration: null,
    },
  });
  return {
    type: 'alert.fired',
    title: context.notification.title,
    message: context.notification.message,
    severity: 'warning',
    resource: context.resource,
    context,
    timestamp,
  };
}
