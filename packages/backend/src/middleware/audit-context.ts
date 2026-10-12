import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import { getClientIpForContext } from '@/lib/request-ip.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import {
  type AuditRequestContext,
  getAuditRequestContext,
  runWithAuditRequestContext,
} from '@/modules/audit/audit-request-context.js';
import { isDemoVisitor } from '@/modules/demo/demo-mode.js';
import type { AppEnv } from '@/types.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SEGMENT = /^[0-9a-f]{16,}$/i;
const TOKENISH_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;
const STABLE_KEBAB_SEGMENT = /^[a-z]+(?:-[a-z]+)+$/;

const FALLBACK_AUDIT_SKIP_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/pki\/ocsp\/[^/]+$/ },
  // Personal UI/AI preferences are user state, not an auditable security or
  // administrative mutation.
  { method: 'PATCH', pattern: /^\/auth\/me\/preferences$/ },
  // Enrollment/challenge initialization only creates short-lived cache state.
  // Audit the eventual confirm, verify, reset, or credential mutation instead.
  { method: 'POST', pattern: /^\/auth\/me\/mfa\/totp\/setup$/ },
  { method: 'POST', pattern: /^\/auth\/me\/passkeys\/options$/ },
  { method: 'POST', pattern: /^\/auth\/me\/mfa\/recovery-codes\/passkey\/options$/ },
  { method: 'POST', pattern: /^\/auth\/mfa\/enrollment\/totp\/setup$/ },
  { method: 'POST', pattern: /^\/auth\/mfa\/enrollment\/passkey\/options$/ },
  { method: 'POST', pattern: /^\/auth\/(?:mfa\/)?passkeys?\/options$/ },
  { method: 'POST', pattern: /^\/auth\/demo\/(?:request|verify)$/ },
  { method: 'POST', pattern: /^\/api\/finalize-setup\/mfa-reminder\/hide$/ },
  { method: 'PUT', pattern: /^\/api\/finalize-setup\/steps\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/setup\/(?:unlock|wizard\/session)$/ },
  { method: 'POST', pattern: /^\/api\/logging\/ingest$/ },
  { method: 'POST', pattern: /^\/api\/logging\/ingest\/batch$/ },
  { method: 'POST', pattern: /^\/api\/logging\/environments\/[^/]+\/search$/ },
  { method: 'POST', pattern: /^\/api\/mcp\/?$/ },
  { method: 'POST', pattern: /^\/api\/ai\/context-estimate$/ },
  { method: 'POST', pattern: /^\/api\/inference\/v1(?:\/|$)/ },
  { method: 'POST', pattern: /^\/api\/inference\/core\/check-updates$/ },
  // Dashboard bootstrap is a read-only aggregate request. Auditing it emits
  // audit.changed, which is itself a bootstrap invalidation trigger.
  { method: 'POST', pattern: /^\/api\/monitoring\/dashboard\/bootstrap$/ },
  { method: 'POST', pattern: /^\/api\/system\/check-update$/ },
  { method: 'POST', pattern: /^\/api\/system\/daemon-updates\/check$/ },
  { method: 'POST', pattern: /^\/api\/system\/license\/check$/ },
  { method: 'POST', pattern: /^\/api\/domains\/preview$/ },
  { method: 'POST', pattern: /^\/api\/domains\/[^/]+\/check-dns$/ },
  { method: 'POST', pattern: /^\/api\/domains\/[^/]+\/ingress-migration\/preview$/ },
  { method: 'POST', pattern: /^\/api\/proxy-hosts\/validate-config$/ },
  { method: 'POST', pattern: /^\/api\/nginx-templates\/(?:preview|test)$/ },
  { method: 'POST', pattern: /^\/api\/nodes\/[^/]+\/config\/test$/ },
  { method: 'POST', pattern: /^\/api\/integrations\/gitlab\/allowlist\/preview-search$/ },
  { method: 'POST', pattern: /^\/api\/integrations\/(?:gitlab|cloudflare)\/connectors\/preview-test$/ },
  {
    method: 'POST',
    pattern: /^\/api\/integrations\/gitlab\/connectors\/[^/]+\/allowlist\/options\/refresh$/,
  },
  { method: 'POST', pattern: /^\/api\/notifications\/webhooks\/preview$/ },
  // A SIEM test is a synthetic collector probe. It must never enter the
  // regular audit stream or create a durable SIEM delivery of its own.
  { method: 'POST', pattern: /^\/api\/audit\/siem\/destinations\/[^/]+\/test$/ },
  { method: 'POST', pattern: /^\/api\/docker\/snapshots\/refresh$/ },
  { method: 'POST', pattern: /^\/api\/docker\/nodes\/[^/]+\/compose-projects\/validate$/ },
  { method: 'POST', pattern: /^\/api\/docker\/migrations\/preflight$/ },
  { method: 'POST', pattern: /^\/api\/docker\/nodes\/[^/]+\/runtime\/runsc\/preflight$/ },
  { method: 'POST', pattern: /^\/api\/docker\/nodes\/[^/]+\/containers\/archive\/plan$/ },
  { method: 'POST', pattern: /^\/api\/docker\/registries\/(?:test|[^/]+\/test)$/ },
  { method: 'POST', pattern: /^\/api\/pages\/projects\/[^/]+\/source\/discovery$/ },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/[^/]+\/(?:containers|deployments)\/[^/]+\/health-check\/test$/,
  },
  { method: 'POST', pattern: /^\/api\/docker\/folders\/placements$/ },
  { method: 'PUT', pattern: /^\/api\/docker\/folders\/reorder$/ },
  { method: 'PUT', pattern: /^\/api\/docker\/folders\/reorder-containers$/ },
  { method: 'PUT', pattern: /^\/api\/docker\/folders\/reorder-resources$/ },
];

interface FallbackAuditTarget {
  action: string;
  resourceType: string;
  resourceId?: string;
}

const NAMED_ROUTE_AUDIT_TARGETS: Array<{
  method: string;
  pattern: RegExp;
  action: string;
  resourceType: string;
  resourceIdGroup?: number;
}> = [
  // 2.12 routes whose own audit entry is written later or only when something changes.
  {
    method: 'POST',
    pattern: /^\/api\/system\/configuration-export$/,
    action: 'system.configuration_export.prepare',
    resourceType: 'system',
  },
  {
    method: 'POST',
    pattern: /^\/api\/apps\/([^/]+)\/promotions\/preview$/,
    action: 'app.promotion.preview',
    resourceType: 'app',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/apps\/members\/place$/,
    action: 'app.members.place',
    resourceType: 'app',
  },
  {
    method: 'PUT',
    pattern: /^\/api\/apps\/([^/]+)\/environments\/([^/]+)\/variables$/,
    action: 'app.environment.variables.update',
    resourceType: 'app_environment',
    resourceIdGroup: 2,
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/apps\/([^/]+)\/environments\/([^/]+)\/secrets$/,
    action: 'app.environment.secrets.update',
    resourceType: 'app_environment',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/apps\/([^/]+)\/environments\/([^/]+)\/nodes$/,
    action: 'app.environment.allow_node',
    resourceType: 'app_environment',
    resourceIdGroup: 2,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/apps\/([^/]+)\/environments\/([^/]+)\/nodes(?:\/[^/]+)?$/,
    action: 'app.environment.remove_node',
    resourceType: 'app_environment',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/update$/,
    action: 'system.update.perform',
    resourceType: 'system-update',
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/relay-update$/,
    action: 'system.relay_update.perform',
    resourceType: 'relay-update',
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/relay\/recovery$/,
    action: 'system.relay.recovery',
    resourceType: 'relay',
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/relay\/rebalance$/,
    action: 'system.relay.rebalance',
    resourceType: 'relay',
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/relay\/instances\/([^/]+)\/drain$/,
    action: 'system.relay.instance.drain',
    resourceType: 'relay-instance',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/relay\/instances\/([^/]+)\/resume$/,
    action: 'system.relay.instance.resume',
    resourceType: 'relay-instance',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/daemon-updates\/([^/]+)$/,
    action: 'system.daemon_update.perform',
    resourceType: 'daemon-update',
    resourceIdGroup: 1,
  },
  {
    method: 'PUT',
    pattern: /^\/api\/ai\/config$/,
    action: 'ai.config.update',
    resourceType: 'ai-config',
  },
  {
    method: 'POST',
    pattern: /^\/api\/inference\/core\/install$/,
    action: 'inference.core.install',
    resourceType: 'inference-core',
  },
  {
    method: 'POST',
    pattern: /^\/api\/inference\/core\/update$/,
    action: 'inference.core.update',
    resourceType: 'inference-core',
  },
  {
    method: 'POST',
    pattern: /^\/api\/inference\/core\/repair$/,
    action: 'inference.core.repair',
    resourceType: 'inference-core',
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/license\/activate$/,
    action: 'license.activate',
    resourceType: 'license',
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/system\/license\/key$/,
    action: 'license.clear',
    resourceType: 'license',
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/cloud\/connect$/,
    action: 'cloud.connect',
    resourceType: 'cloud-link',
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/cloud\/remote-management$/,
    action: 'cloud.remote_management',
    resourceType: 'cloud-link',
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/cloud\/disconnect$/,
    action: 'cloud.disconnect',
    resourceType: 'cloud-link',
  },
  {
    method: 'PUT',
    pattern: /^\/api\/housekeeping\/config$/,
    action: 'housekeeping.config.update',
    resourceType: 'housekeeping-config',
  },
  {
    method: 'POST',
    pattern: /^\/api\/housekeeping\/run$/,
    action: 'housekeeping.run',
    resourceType: 'housekeeping-run',
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/settings\/environment$/,
    action: 'settings.environment.update',
    resourceType: 'environment-settings',
  },
  {
    method: 'POST',
    pattern: /^\/api\/setup\/wizard\/apply$/,
    action: 'setup.wizard.apply',
    resourceType: 'system-setup',
  },
  {
    method: 'POST',
    pattern: /^\/api\/setup\/wizard\/license\/community$/,
    action: 'setup.license.community',
    resourceType: 'system-setup',
  },
  {
    method: 'POST',
    pattern: /^\/api\/setup\/wizard\/license\/activate$/,
    action: 'setup.license.activate',
    resourceType: 'system-setup',
  },
  {
    method: 'POST',
    pattern: /^\/api\/setup\/wizard\/complete$/,
    action: 'setup.wizard.complete',
    resourceType: 'system-setup',
  },
  {
    method: 'POST',
    pattern: /^\/api\/audit\/export$/,
    action: 'audit.export',
    resourceType: 'audit-log',
  },
  {
    method: 'POST',
    pattern: /^\/api\/alerts\/([^/]+)\/dismiss$/,
    action: 'alert.dismiss',
    resourceType: 'alert',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/audit\/siem\/deliveries\/([^/]+)\/requeue$/,
    action: 'siem.delivery.requeue',
    resourceType: 'siem-delivery',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/runtime\/runsc\/install$/,
    action: 'docker.runtime.runsc.install',
    resourceType: 'docker-node',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/tasks\/([^/]+)\/force-cancel$/,
    action: 'docker.task.force_cancel',
    resourceType: 'docker-task',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/registries\/internal\/maintenance\/([^/]+)\/resume$/,
    action: 'docker.internal_registry.maintenance.resume',
    resourceType: 'docker-registry-maintenance',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/notifications\/webhooks\/([^/]+)\/test$/,
    action: 'notification.webhook.test',
    resourceType: 'notification-webhook',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/ai\/conversation-folders$/,
    action: 'ai.conversation_folder.create',
    resourceType: 'ai-conversation-folder',
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/ai\/conversation-folders\/([^/]+)$/,
    action: 'ai.conversation_folder.update',
    resourceType: 'ai-conversation-folder',
    resourceIdGroup: 1,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/ai\/conversation-folders\/([^/]+)$/,
    action: 'ai.conversation_folder.delete',
    resourceType: 'ai-conversation-folder',
    resourceIdGroup: 1,
  },
  {
    method: 'PUT',
    pattern: /^\/api\/ai\/conversation-folders\/reorder$/,
    action: 'ai.conversation_folder.reorder',
    resourceType: 'ai-conversation-folder',
  },
  {
    method: 'PUT',
    pattern: /^\/api\/ai\/conversation-folders\/move-conversations$/,
    action: 'ai.conversation_folder.move_conversations',
    resourceType: 'ai-conversation-folder',
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/ai\/conversations\/([^/]+)$/,
    action: 'ai.conversation.update',
    resourceType: 'ai-conversation',
    resourceIdGroup: 1,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/ai\/conversations\/([^/]+)$/,
    action: 'ai.conversation.delete',
    resourceType: 'ai-conversation',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/ai\/conversations\/([^/]+)\/rollback$/,
    action: 'ai.conversation.rollback',
    resourceType: 'ai-conversation',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/ai\/sandbox\/jobs\/([^/]+)\/kill$/,
    action: 'ai.sandbox_job.kill',
    resourceType: 'ai-sandbox-job',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/ai\/sandbox\/artifacts$/,
    action: 'ai.sandbox_artifact.create',
    resourceType: 'ai-sandbox-artifact',
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/ai\/sandbox\/artifacts\/([^/]+)$/,
    action: 'ai.sandbox_artifact.delete',
    resourceType: 'ai-sandbox-artifact',
    resourceIdGroup: 1,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers$/,
    action: 'docker.container.create',
    resourceType: 'docker-container',
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/start$/,
    action: 'docker.container.start',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/stop$/,
    action: 'docker.container.stop',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/restart$/,
    action: 'docker.container.restart',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/kill$/,
    action: 'docker.container.kill',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)$/,
    action: 'docker.container.remove',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/rename$/,
    action: 'docker.container.rename',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/duplicate$/,
    action: 'docker.container.duplicate',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/update$/,
    action: 'docker.container.update',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/live-update$/,
    action: 'docker.container.live_update',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/recreate$/,
    action: 'docker.container.recreate',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'PUT',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/env$/,
    action: 'docker.container.env.update',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'PUT',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/containers\/([^/]+)\/files\/write$/,
    action: 'docker.file.write',
    resourceType: 'docker-container',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/images\/pull(?:-sync)?$/,
    action: 'docker.image.pull',
    resourceType: 'docker-image',
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/images\/([^/]+)$/,
    action: 'docker.image.remove',
    resourceType: 'docker-image',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/images\/prune$/,
    action: 'docker.image.prune',
    resourceType: 'docker-image',
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/volumes$/,
    action: 'docker.volume.create',
    resourceType: 'docker-volume',
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/volumes\/([^/]+)$/,
    action: 'docker.volume.remove',
    resourceType: 'docker-volume',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/networks$/,
    action: 'docker.network.create',
    resourceType: 'docker-network',
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/networks\/([^/]+)$/,
    action: 'docker.network.remove',
    resourceType: 'docker-network',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/networks\/([^/]+)\/connect$/,
    action: 'docker.network.connect',
    resourceType: 'docker-network',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/networks\/([^/]+)\/disconnect$/,
    action: 'docker.network.disconnect',
    resourceType: 'docker-network',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments$/,
    action: 'docker.deployment.create',
    resourceType: 'docker-deployment',
  },
  {
    method: 'PUT',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments\/([^/]+)$/,
    action: 'docker.deployment.update',
    resourceType: 'docker-deployment',
    resourceIdGroup: 2,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments\/([^/]+)$/,
    action: 'docker.deployment.delete',
    resourceType: 'docker-deployment',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments\/([^/]+)\/start$/,
    action: 'docker.deployment.start',
    resourceType: 'docker-deployment',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments\/([^/]+)\/stop$/,
    action: 'docker.deployment.stop',
    resourceType: 'docker-deployment',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments\/([^/]+)\/restart$/,
    action: 'docker.deployment.restart',
    resourceType: 'docker-deployment',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments\/([^/]+)\/kill$/,
    action: 'docker.deployment.kill',
    resourceType: 'docker-deployment',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments\/([^/]+)\/deploy$/,
    action: 'docker.deployment.deploy',
    resourceType: 'docker-deployment',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments\/([^/]+)\/switch$/,
    action: 'docker.deployment.switch',
    resourceType: 'docker-deployment',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments\/([^/]+)\/rollback$/,
    action: 'docker.deployment.rollback',
    resourceType: 'docker-deployment',
    resourceIdGroup: 2,
  },
  {
    method: 'POST',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/deployments\/([^/]+)\/slots\/[^/]+\/stop$/,
    action: 'docker.deployment.slot.stop',
    resourceType: 'docker-deployment',
    resourceIdGroup: 2,
  },
  {
    method: 'PUT',
    pattern: /^\/api\/docker\/nodes\/([^/]+)\/(?:containers|deployments)\/([^/]+)\/health-check$/,
    action: 'docker.health_check.configure',
    resourceType: 'docker-health-check',
    resourceIdGroup: 2,
  },
];

function shouldEmitFallbackAudit(c: Parameters<MiddlewareHandler<AppEnv>>[0]): boolean {
  if (!MUTATING_METHODS.has(c.req.method)) {
    return false;
  }

  if (shouldSkipFallbackAudit(c.req.method, c.req.path)) {
    return false;
  }

  if (isDemoVisitor(c.get('user')) && c.req.path.startsWith('/auth/')) {
    return false;
  }

  if (c.res.status < 200 || c.res.status >= 400) {
    return false;
  }

  return !getAuditRequestContext()?.auditEmitted;
}

function shouldSkipFallbackAudit(method: string, path: string): boolean {
  return FALLBACK_AUDIT_SKIP_ROUTES.some((route) => route.method === method && route.pattern.test(path));
}

function resolveFallbackAuditTarget(method: string, path: string): FallbackAuditTarget {
  for (const target of NAMED_ROUTE_AUDIT_TARGETS) {
    if (target.method !== method) continue;
    const match = target.pattern.exec(path);
    if (!match) continue;
    return {
      action: target.action,
      resourceType: target.resourceType,
      resourceId: target.resourceIdGroup ? decodeURIComponent(match[target.resourceIdGroup] ?? '') : undefined,
    };
  }

  const authTarget = resolveAuthFallbackAuditTarget(method, path);
  if (authTarget) return authTarget;

  return {
    action: `route.${method.toLowerCase()}`,
    resourceType: 'http-route',
  };
}

function resolveAuthFallbackAuditTarget(method: string, path: string): FallbackAuditTarget | null {
  if (!path.startsWith('/auth/')) return null;
  const routeName = sanitizeAuditPath(path)
    .split('/')
    .slice(2)
    .filter((segment) => segment && !segment.startsWith(':'))
    .join('_')
    .replaceAll('-', '_');
  if (!routeName) return null;
  const mutation = method === 'DELETE' ? '.delete' : method === 'PATCH' || method === 'PUT' ? '.update' : '';
  return {
    action: `auth.${routeName}${mutation}`,
    resourceType: path.startsWith('/auth/me/') ? 'user' : 'session',
  };
}

function sanitizeAuditPath(path: string): string {
  const segments = path.split('/');
  return segments
    .map((segment) => {
      if (!segment) {
        return segment;
      }
      if (UUID_SEGMENT.test(segment)) {
        return ':id';
      }
      // Stable route names such as compose-projects can be long enough to
      // resemble opaque tokens. Preserve lowercase kebab-case route segments.
      if (STABLE_KEBAB_SEGMENT.test(segment)) {
        return segment;
      }
      if (HEX_SEGMENT.test(segment) || TOKENISH_SEGMENT.test(segment)) {
        return ':redacted';
      }
      return segment;
    })
    .join('/');
}

export const auditContextMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const context: AuditRequestContext = {
    requestId: c.get('requestId'),
    ipAddress: await getClientIpForContext(c),
    userAgent: c.req.header('user-agent'),
    auditEmitted: false,
  };

  await runWithAuditRequestContext(context, async () => {
    await next();

    if (!shouldEmitFallbackAudit(c)) {
      return;
    }

    const auditService = container.resolve(AuditService);
    const target = resolveFallbackAuditTarget(c.req.method, c.req.path);
    await auditService.log({
      // A sign-in has no session user yet: the account it signed in (setAuditSubjectUser).
      userId: c.get('user')?.id ?? context.subjectUserId ?? null,
      action: target.action,
      resourceType: target.resourceType,
      resourceId: target.resourceId || undefined,
      details: {
        path: sanitizeAuditPath(c.req.path),
        status: c.res.status,
      },
    });
  });
};

export const __testOnly = {
  resolveFallbackAuditTarget,
  sanitizeAuditPath,
  shouldSkipFallbackAudit,
};
