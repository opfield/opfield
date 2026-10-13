import { ALERT_CATEGORIES } from './notification-catalog.js';
import { formatDurationSeconds } from './notification-templates.js';

/**
 * Opfield's resolve texts: what a reader is told once an alert clears, for rules without a resolve message. They name
 * the recovery ("... is back online"), never repeat the firing message, and end with how long the alert lasted.
 */
const EVENT_RESOLVE_TEXT: Record<string, (name: string) => string> = {
  'hosting_vm:firewall.failed': (name) => `The firewall of VM ${name} is in sync again`,
  'hosting_account:sync.failed': (name) => `Hosting account ${name} synchronizes again`,
  'node:offline': (name) => `Node ${name} is back online`,
  'container:stopped': (name) => `Container ${name} is running again`,
  'container:exited': (name) => `Container ${name} is running again`,
  'container:health.offline': (name) => `Container ${name} is back online`,
  'container:health.degraded': (name) => `Container ${name} is healthy again`,
  'container:dependency.database_offline': (name) => `The database link of container ${name} is back online`,
  'container:deployment.failed': (name) => `Deployment ${name} is healthy again`,
  'container:migration.needs_attention': (name) => `The migration of ${name} no longer needs attention`,
  'proxy:health.offline': (name) => `Route ${name} is back online`,
  'proxy:health.degraded': (name) => `Route ${name} is healthy again`,
  'proxy:maintenance.active': (name) => `Route ${name} is out of maintenance`,
  'proxy:secure_link.reconciliation_failed': (name) => `The Secure Link of route ${name} is in sync again`,
  'pages:quota.blocked': (name) => `Pages project ${name} is within its quota again`,
  'pages:profile.unavailable': (name) => `Wildcard profile ${name} is available again`,
  'opfield:postgres.unavailable': () => 'Postgres is available again',
  'opfield:redis.unavailable': () => 'Redis is available again',
  'opfield:container.unhealthy': (name) => `${name} is running and healthy again`,
  'opfield:job.failing': (name) => `${name} runs without errors again`,
  'opfield:relay.recovering': (name) => `${name} is serving again`,
  'opfield:relay.unavailable': (name) => `${name} is serving again`,
  'opfield:relay.unreachable': (name) => `Nodes reach ${name} again`,
  'opfield:outbound.unavailable': () => 'Opfield has outbound connectivity again',
  'opfield:license.expired_grace': () => 'The license is valid again',
  'opfield:license.unavailable': () => 'The paid license is available again',
  'logging:storage.pressure': (name) => `Logging storage of ${name} is back to normal`,
  'logging:storage.degraded': (name) => `Logging storage of ${name} is back to normal`,
  'logging:storage.exhausted': (name) => `Logging storage of ${name} has space again`,
  'logging:storage.unavailable': (name) => `Logging storage of ${name} is available again`,
  'certificate:internal.renewal_failed': (name) => `The certificate of ${name} renews again`,
  'database_postgres:health.offline': (name) => `Database ${name} is back online`,
  'database_postgres:health.degraded': (name) => `Database ${name} is healthy again`,
  'database_clickhouse:health.offline': (name) => `Database ${name} is back online`,
  'database_clickhouse:health.degraded': (name) => `Database ${name} is healthy again`,
  'database_redis:health.offline': (name) => `Database ${name} is back online`,
  'database_redis:health.degraded': (name) => `Database ${name} is healthy again`,
  'managed_storage:storage.full': (name) => `Storage ${name} takes uploads again`,
  ...Object.fromEntries(
    (['database_postgres', 'database_clickhouse', 'database_redis', 'managed_storage'] as const).flatMap((category) => {
      const noun = category === 'managed_storage' ? 'Storage' : 'Database';
      return [
        [`${category}:availability.degraded`, (name: string) => `${noun} ${name} runs on all its servers again`],
        [`${category}:availability.no_failover`, (name: string) => `${noun} ${name} can fail over again`],
      ];
    })
  ),
};

function categoryOf(rule: { category?: string | null }) {
  return ALERT_CATEGORIES.find((category) => category.id === rule.category);
}

function formatMetricValue(value: number, unit: string): string {
  const rounded = Math.round(value * 10) / 10;
  if (unit === '%') return `${rounded}%`;
  if (!unit || unit === 'state') return String(rounded);
  return `${rounded} ${unit}`;
}

/**
 * The resolve message of a rule without a resolve message template: a built-in text for the rule's event, the
 * metric back to normal for a threshold rule, or the event cleared, followed by how long the alert lasted.
 */
export function defaultResolveMessage(
  rule: {
    name: string;
    type?: string | null;
    category?: string | null;
    eventPattern?: string | null;
    metric?: string | null;
  },
  resourceName: string,
  details: { metric?: { value?: number | null } | null; fired?: { duration?: number | null } | null } = {}
): string {
  const category = categoryOf(rule);
  let text: string;
  if (rule.type === 'threshold') {
    const metric = category?.metrics.find((item) => item.id === rule.metric);
    const label = (metric?.label ?? rule.metric ?? rule.name).replace(/\s*\([^)]*\)\s*$/, '');
    const value = details.metric?.value;
    if (rule.category === 'certificate' && rule.metric === 'days_until_expiry') {
      text = `Certificate ${resourceName} no longer expires soon`;
    } else {
      text = `${label} on ${resourceName} is back to normal`;
      if (typeof value === 'number' && Number.isFinite(value)) {
        text += ` at ${formatMetricValue(value, metric?.unit ?? '')}`;
      }
    }
  } else {
    const builtIn = EVENT_RESOLVE_TEXT[`${rule.category}:${rule.eventPattern}`];
    const eventPattern = rule.eventPattern ?? '';
    if (builtIn) {
      text = builtIn(resourceName);
    } else if (rule.category === 'hosting_vm' && eventPattern.startsWith('power.')) {
      text = `VM ${resourceName} is no longer ${eventPattern.slice('power.'.length)}`;
    } else {
      const label = category?.events.find((event) => event.id === eventPattern)?.label ?? rule.name;
      text = `${label} has cleared on ${resourceName}`;
    }
  }
  const duration = details.fired?.duration;
  if (typeof duration === 'number' && duration > 0) text += ` after ${formatDurationSeconds(duration)}`;
  return `${text}.`;
}

/**
 * The template a resolve renders: the rule's resolve message, or a firing message written for both states (it reads
 * alert.status, as templates did before rules had a resolve message). Null uses defaultResolveMessage.
 */
export function resolveTemplateOf(rule: {
  messageTemplate?: string | null;
  resolveMessageTemplate?: string | null;
}): string | null {
  if (rule.resolveMessageTemplate?.trim()) return rule.resolveMessageTemplate;
  if (rule.messageTemplate && /\balert\.status\b/.test(rule.messageTemplate)) return rule.messageTemplate;
  return null;
}
