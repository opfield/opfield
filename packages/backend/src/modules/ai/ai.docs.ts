import { hasScopeBase } from '@/lib/permissions.js';
import { APP_DOCS } from './ai.docs.apps.js';
import { CONNECTIVITY_DOCS } from './ai.docs.connectivity.js';
import { FOUNDATION_DOCS } from './ai.docs.foundation.js';
import { GUIDE_DOCS } from './ai.docs.guides.js';
import { HOSTING_DOCS } from './ai.docs.hosting.js';
import { INFRASTRUCTURE_DOCS } from './ai.docs.infrastructure.js';
import { INGRESS_GROUP_DOCS } from './ai.docs.ingress-groups.js';
import { OPERATIONS_DOCS } from './ai.docs.operations.js';
import { PLATFORM_DOCS } from './ai.docs.platform.js';

export const INTERNAL_DOCS: Record<string, string> = {
  ...FOUNDATION_DOCS,
  ...INGRESS_GROUP_DOCS,
  ...APP_DOCS,
  ...INFRASTRUCTURE_DOCS,
  ...HOSTING_DOCS,
  ...CONNECTIVITY_DOCS,
  ...OPERATIONS_DOCS,
  ...PLATFORM_DOCS,
  ...GUIDE_DOCS,
};

/** Map doc topics to the scope required to read them */
export const DOC_TOPIC_SCOPES: Record<string, string | string[]> = {
  discovery: ['ai:workspace:use', 'mcp:use'],
  pki: 'pki:ca:view',
  ssl: 'ssl:cert:view',
  proxy: 'proxy:view',
  pages: 'pages:view',
  domains: 'domains:view',
  'ingress-groups': ['ingress:groups:view', 'ingress:groups:manage', 'proxy:view', 'domains:view'],
  // Member view scopes too: an app is visible through the members the caller can view.
  apps: [
    'apps:view',
    'apps:create',
    'apps:edit',
    'apps:delete',
    'apps:env:manage',
    'apps:promote',
    'apps:operate',
    'docker:containers:view',
    'docker:compose:view',
    'databases:view',
    'storage:view',
    'proxy:view',
    'pages:view',
  ],
  'access-lists': 'acl:view',
  templates: 'pki:templates:view',
  acme: 'ssl:cert:view',
  users: 'admin:users',
  audit: ['admin:audit', 'audit:siem:view'],
  siem: 'audit:siem:view',
  nginx: 'proxy:edit',
  nodes: 'nodes:details',
  hosting: [
    'integrations:hosting:view',
    'integrations:hosting:manage',
    'hosting:resources:view',
    'hosting:resources:create',
  ],
  // Every assistant and MCP connection may read it: folder-limited agents need it, not only folder managers.
  folders: [
    'ai:workspace:use',
    'mcp:use',
    'nodes:folders:manage',
    'databases:folders:manage',
    'domains:folders:manage',
    'logs:environments:folders:manage',
    'logs:schemas:folders:manage',
    'admin:users:folders:manage',
    'admin:groups:folders:manage',
    'proxy:folders:manage',
    'docker:folders:manage',
  ],
  'node-files': ['nodes:files:read', 'nodes:files:write'],
  docker: ['docker:containers:view', 'docker:compose:view'],
  availability: ['docker:availability:manage', 'docker:containers:view', 'docker:compose:view'],
  sandbox: 'ai:sandbox:use',
  conversations: ['ai:workspace:use', 'mcp:use'],
  databases: 'databases:view',
  storage: 'storage:view',
  'storage-migration': 'storage:view',
  postgres: 'databases:view',
  redis: 'databases:view',
  logging: ['logs:environments:view', 'logs:schemas:view', 'logs:read'],
  'ai-settings': 'feat:ai:configure',
  'status-page': 'status-page:view',
  housekeeping: 'housekeeping:view',
  permissions: ['ai:workspace:use', 'mcp:use'],
  api: ['ai:workspace:use', 'mcp:use'],
  'opfield-settings': ['settings:opfield:view', 'settings:opfield:edit'],
  'licensing-updates': ['license:view', 'license:manage', 'admin:update'],
  inference: [
    'ai:workspace:use',
    'feat:ai:use',
    'inference:providers:view',
    'inference:providers:manage',
    'inference:models:manage',
    'inference:limits:manage',
    'inference:usage:view',
    'settings:opfield:edit',
  ],
  gitlab: 'integrations:gitlab:view',
  integrations: [
    'integrations:github:view',
    'integrations:git:view',
    'integrations:ssh:view',
    'integrations:cloudflare:view',
    'integrations:gitlab:view',
  ],
  relays: ['settings:opfield:view', 'nodes:details', 'admin:system'],
  notifications: ['notifications:alerts:view', 'notifications:webhooks:view', 'audit:siem:view', 'admin:alerts'],
  overview: ['ai:workspace:use', 'mcp:use'],
  installation: ['ai:workspace:use', 'mcp:use'],
  authentication: ['ai:workspace:use', 'mcp:use'],
  cloudflare: 'integrations:cloudflare:view',
  'docker-registries': 'docker:registries:view',
  clickhouse: 'databases:view',
  troubleshooting: ['ai:workspace:use', 'mcp:use'],
};

export function getInternalDocumentation(topic: string, userScopes: string[]): { topic: string; content: string } {
  const content = INTERNAL_DOCS[topic];
  if (!content) {
    // Only list topics the user has access to
    const available = Object.keys(INTERNAL_DOCS).filter((t) => hasDocTopicAccess(userScopes, DOC_TOPIC_SCOPES[t]));
    return {
      topic,
      content: `Unknown topic "${topic}". Available topics: ${available.join(', ')}.`,
    };
  }
  const requiredScope = DOC_TOPIC_SCOPES[topic];
  if (!hasDocTopicAccess(userScopes, requiredScope)) {
    return { topic, content: `You do not have permission to access documentation for "${topic}".` };
  }
  return { topic, content };
}

function hasDocTopicAccess(userScopes: string[], requiredScope: string | string[] | undefined) {
  if (!requiredScope) return true;
  const scopes = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
  return scopes.some((scope) => hasScopeBase(userScopes, scope));
}
