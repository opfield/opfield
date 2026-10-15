import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accessLists } from './access-lists.js';
import { certificates } from './certificates.js';
import { dockerComposeProjects } from './docker-compose.js';
import { dockerDeployments } from './docker-deployments.js';
import { ingressGroups } from './ingress-groups.js';
import { nginxTemplates } from './nginx-templates.js';
import { nodes } from './nodes.js';
import { proxyHostTypeEnum } from './proxy-enums.js';
import { proxyHostFolders } from './proxy-host-folders.js';
import { sslCertificates } from './ssl-certificates.js';
import { users } from './users.js';

export { proxyHostTypeEnum } from './proxy-enums.js';
export const forwardSchemeEnum = pgEnum('forward_scheme', ['http', 'https']);
export const proxyUpstreamKindEnum = pgEnum('proxy_upstream_kind', [
  'manual',
  'docker_container',
  'docker_deployment',
  'pages',
  'managed_storage',
]);
export const healthStatusEnum = pgEnum('health_status', ['online', 'offline', 'degraded', 'unknown', 'disabled']);
export const healthCheckBodyMatchModeEnum = pgEnum('health_check_body_match_mode', [
  'includes',
  'exact',
  'starts_with',
  'ends_with',
]);

export interface CustomHeader {
  name: string;
  value: string;
}

export interface CacheOptions {
  maxAge?: number;
  staleWhileRevalidate?: number;
}

export interface RateLimitOptions {
  requestsPerSecond: number;
  burst?: number;
  connectionsPerIp?: number;
}

export type RateLimitMode = 'inherit' | 'custom' | 'disabled';

/**
 * Where nginx takes the client address of a request from (route-client-ip.ts): auto uses Cloudflare's edge header
 * when a name of the route is a Cloudflare-proxied domain, else the TCP peer.
 */
export type RouteClientIpSource = 'auto' | 'direct' | 'cloudflare' | 'reverse_proxy';

export interface RouteClientIpOptions {
  /** Peers (addresses or CIDRs) whose forwarded header is trusted in reverse_proxy mode. */
  trustedProxyCidrs: string[];
  header: 'x_forwarded_for' | 'x_real_ip';
}

export interface RewriteRule {
  source: string;
  destination: string;
  type: 'permanent' | 'temporary';
}

/** Loopback TCP address slots of Secure Links (proxy hosts and additional links share it, so slots never repeat). */
export const secureLinkLoopbackSlotSeq = pgSequence('secure_link_loopback_slot_seq', {
  startWith: 1,
  minValue: 1,
  maxValue: 12000000,
  cycle: false,
});

export const proxyHosts = pgTable(
  'proxy_hosts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: proxyHostTypeEnum('type').notNull().default('proxy'),
    domainNames: jsonb('domain_names').$type<string[]>().notNull().default([]),
    slug: varchar('slug', { length: 60 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    maintenanceEnabled: boolean('maintenance_enabled').notNull().default(false),
    maintenanceStartedAt: timestamp('maintenance_started_at', { withTimezone: true }),
    // App maintenance overlay, computed by the apps service (off|maintenance|lockdown); never written by route edits.
    // The effective maintenance of a route is maintenanceEnabled OR this is not 'off'.
    appMaintenanceMode: varchar('app_maintenance_mode', { length: 16 }).notNull().default('off'),

    // Upstream — for proxy type
    upstreamKind: proxyUpstreamKindEnum('upstream_kind').notNull().default('manual'),
    forwardHost: varchar('forward_host', { length: 255 }),
    forwardPort: integer('forward_port'),
    forwardScheme: forwardSchemeEnum('forward_scheme').default('http'),
    upstreamIpv6Enabled: boolean('upstream_ipv6_enabled').notNull().default(false),
    dockerNodeId: uuid('docker_node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    dockerContainerName: varchar('docker_container_name', { length: 255 }),
    dockerComposeProjectId: uuid('docker_compose_project_id').references(() => dockerComposeProjects.id, {
      onDelete: 'restrict',
    }),
    dockerComposeServiceName: varchar('docker_compose_service_name', { length: 255 }),
    dockerDeploymentId: uuid('docker_deployment_id').references(() => dockerDeployments.id, {
      onDelete: 'restrict',
    }),
    dockerContainerPort: integer('docker_container_port'),
    dockerHostPort: integer('docker_host_port'),
    dockerProtocol: varchar('docker_protocol', { length: 8 }),
    relaySpreadMode: varchar('relay_spread_mode', { length: 16 })
      .$type<'inherit' | 'fixed' | 'all'>()
      .notNull()
      .default('inherit'),
    relaySpreadCount: integer('relay_spread_count'),

    // Internal Proxy Host -> Docker Secure Link runtime state. These fields
    // are control-plane metadata and are not exposed as a selectable upstream.
    secureLinkGeneration: integer('secure_link_generation').notNull().default(0),
    secureLinkStatus: varchar('secure_link_status', { length: 32 }).notNull().default('legacy'),
    secureLinkLastError: text('secure_link_last_error'),
    secureLinkTargetNetwork: varchar('secure_link_target_network', { length: 255 }),
    secureLinkTargetContainer: varchar('secure_link_target_container', { length: 255 }),
    secureLinkTargetHost: varchar('secure_link_target_host', { length: 255 }),
    secureLinkListenerPort: integer('secure_link_listener_port'),
    // The link's loopback TCP address on its nginx nodes (secureLinkLoopbackAddress); unique across both link tables.
    secureLinkLoopbackSlot: integer('secure_link_loopback_slot')
      .notNull()
      .default(sql`nextval('secure_link_loopback_slot_seq')`),
    secureLinkConnectorPort: integer('secure_link_connector_port'),
    secureLinkMigratedAt: timestamp('secure_link_migrated_at', { withTimezone: true }),

    // SSL
    sslEnabled: boolean('ssl_enabled').notNull().default(false),
    sslForced: boolean('ssl_forced').notNull().default(false), // HTTP → HTTPS redirect
    http2Support: boolean('http2_support').notNull().default(true),
    // Restrict: a certificate a host still serves cannot be deleted (409 CERT_IN_USE).
    sslCertificateId: uuid('ssl_certificate_id').references(() => sslCertificates.id, { onDelete: 'restrict' }),
    internalCertificateId: uuid('internal_certificate_id').references(() => certificates.id, { onDelete: 'set null' }),

    // Proxy options
    websocketSupport: boolean('websocket_support').notNull().default(false),

    // Redirect type options
    redirectUrl: text('redirect_url'),
    redirectStatusCode: integer('redirect_status_code').default(301),

    // Custom config — structured
    customHeaders: jsonb('custom_headers').$type<CustomHeader[]>().default([]),
    cacheEnabled: boolean('cache_enabled').notNull().default(false),
    cacheOptions: jsonb('cache_options').$type<CacheOptions>(),
    rateLimitEnabled: boolean('rate_limit_enabled').notNull().default(false),
    rateLimitMode: varchar('rate_limit_mode', { length: 16 }).$type<RateLimitMode>().notNull().default('inherit'),
    rateLimitOptions: jsonb('rate_limit_options').$type<RateLimitOptions>(),
    clientIpSource: varchar('client_ip_source', { length: 16 }).$type<RouteClientIpSource>().notNull().default('auto'),
    clientIpOptions: jsonb('client_ip_options').$type<RouteClientIpOptions>(),
    customRewrites: jsonb('custom_rewrites').$type<RewriteRule[]>().default([]),

    // Custom config — raw nginx
    advancedConfig: text('advanced_config'),

    // Raw config override — bypasses template rendering entirely
    rawConfig: text('raw_config'),
    rawConfigEnabled: boolean('raw_config_enabled').notNull().default(false),

    // Folder / organization
    folderId: uuid('folder_id').references(() => proxyHostFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),

    // Nginx config template
    nginxTemplateId: uuid('nginx_template_id').references(() => nginxTemplates.id, { onDelete: 'set null' }),
    templateVariables: jsonb('template_variables').$type<Record<string, string | number | boolean>>().default({}),

    // Access list
    accessListId: uuid('access_list_id').references(() => accessLists.id, { onDelete: 'set null' }),

    // Node assignment. A route served by an ingress group keeps its group's first member here (kept in sync by the
    // ingress group service); resolveIngressNodes() is the only source of the full member set.
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    ingressGroupId: uuid('ingress_group_id').references(() => ingressGroups.id, { onDelete: 'restrict' }),

    // Health check
    healthCheckEnabled: boolean('health_check_enabled').notNull().default(false),
    healthCheckUrl: varchar('health_check_url', { length: 500 }).default('/'),
    healthCheckInterval: integer('health_check_interval').default(30), // seconds
    healthCheckExpectedStatus: integer('health_check_expected_status'), // null = accept 2xx
    healthCheckExpectedBody: varchar('health_check_expected_body', { length: 500 }), // null = don't check body
    healthCheckBodyMatchMode: healthCheckBodyMatchModeEnum('health_check_body_match_mode')
      .notNull()
      .default('includes'),
    healthCheckSlowThreshold: integer('health_check_slow_threshold').default(3), // Nx multiplier for response time degradation
    healthStatus: healthStatusEnum('health_status').default('unknown'),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    healthHistory: jsonb('health_history')
      .$type<Array<{ ts: string; status: string; responseMs?: number; slow?: boolean }>>()
      .default([]),

    // System flag — locked hosts cannot be deleted (e.g. management proxy)
    isSystem: boolean('is_system').notNull().default(false),
    systemKind: varchar('system_kind', { length: 50 }),

    // Metadata
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    enabledIdx: index('proxy_host_enabled_idx').on(table.enabled),
    secureLinkLoopbackSlotUnique: uniqueIndex('proxy_hosts_secure_link_loopback_slot_unique').on(
      table.secureLinkLoopbackSlot
    ),
    typeIdx: index('proxy_host_type_idx').on(table.type),
    folderIdx: index('proxy_host_folder_idx').on(table.folderId),
    createdByIdx: index('proxy_host_created_by_idx').on(table.createdById),
    nodeIdx: index('proxy_host_node_idx').on(table.nodeId),
    ingressGroupIdx: index('proxy_host_ingress_group_idx').on(table.ingressGroupId),
    dockerNodeIdx: index('proxy_host_docker_node_idx').on(table.dockerNodeId),
    dockerComposeProjectIdx: index('proxy_host_docker_compose_project_idx').on(table.dockerComposeProjectId),
    dockerDeploymentIdx: index('proxy_host_docker_deployment_idx').on(table.dockerDeploymentId),
    systemKindIdx: index('proxy_host_system_kind_idx').on(table.systemKind),
    relaySpreadModeValid: check(
      'proxy_hosts_relay_spread_mode_valid',
      sql`${table.relaySpreadMode} IN ('inherit', 'fixed', 'all')`
    ),
    relaySpreadCountValid: check(
      'proxy_hosts_relay_spread_count_valid',
      sql`(${table.relaySpreadMode} = 'fixed' AND ${table.relaySpreadCount} BETWEEN 1 AND 64) OR (${table.relaySpreadMode} <> 'fixed' AND ${table.relaySpreadCount} IS NULL)`
    ),
    slugUnique: unique('proxy_hosts_slug_unique').on(table.slug),
  })
);

/**
 * The names each proxy host serves, one row per lowercased domain and serving
 * node, kept in sync with `proxy_hosts` (domains, enabled, node, ingress group)
 * and `ingress_group_members` by triggers (migrations 0207, 0209 and the ingress
 * group migration). A host on an ingress group has one row per member, so the
 * partial unique index guarantees that two enabled hosts never serve the same
 * name on any node. `legacy_conflict` marks duplicates that existed before the
 * index; they stay outside it until their host's domains, node or enabled state
 * change, and the service's overlap check still reports them.
 */
export const proxyHostDomains = pgTable(
  'proxy_host_domains',
  {
    proxyHostId: uuid('proxy_host_id')
      .notNull()
      .references(() => proxyHosts.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    enabled: boolean('enabled').notNull(),
    legacyConflict: boolean('legacy_conflict').notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.proxyHostId, table.nodeId, table.domain], name: 'proxy_host_domains_pkey' }),
    uniqueIndex('proxy_host_domains_node_domain_unique')
      .on(table.nodeId, table.domain)
      .where(sql`${table.enabled} = true AND ${table.legacyConflict} = false`),
    index('proxy_host_domains_node_domain_idx').on(table.nodeId, table.domain),
  ]
);
