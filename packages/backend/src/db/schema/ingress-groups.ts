import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { nodeFolders } from './node-folders.js';
import { nodes } from './nodes.js';
import { users } from './users.js';

/**
 * How DNS follows the health of a group's members. `none` publishes the union of the members' ingress addresses
 * (round robin, no health). The DNS failover tracks add their modes to this list and to the check constraint.
 */
export const INGRESS_GROUP_DNS_FAILOVER_MODES = ['none'] as const;
export type IngressGroupDnsFailoverMode = (typeof INGRESS_GROUP_DNS_FAILOVER_MODES)[number];

/**
 * A set of nginx ingress nodes that serve the same routes and domains (normally one per site). Routes and domains
 * target either one node (`node_id`, as before) or a group (`ingress_group_id`); a group's members get the same
 * config, certificates, access lists, Pages artifacts and secure-link sources. Groups live in node folders.
 */
export const ingressGroups = pgTable(
  'ingress_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 60 }).notNull(),
    description: text('description'),
    folderId: uuid('folder_id').references(() => nodeFolders.id, { onDelete: 'set null' }),
    dnsFailoverMode: varchar('dns_failover_mode', { length: 32 })
      .$type<IngressGroupDnsFailoverMode>()
      .notNull()
      .default('none'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUnique: unique('ingress_groups_slug_unique').on(table.slug),
    folderIdx: index('ingress_groups_folder_idx').on(table.folderId),
    dnsFailoverModeValid: check('ingress_groups_dns_failover_mode_valid', sql`${table.dnsFailoverMode} IN ('none')`),
  })
);

/**
 * `joining`: receives the group's config, certificates and secure-link sources but is not published in DNS until
 * every route reached it. `active`: serves and is published. `draining`: being removed; it still serves (and keeps
 * receiving the group's config) but is no longer published, until DNS stopped pointing at it; then its config,
 * certificates and secure-link sources are removed and the row is deleted.
 */
export const INGRESS_GROUP_MEMBER_STATES = ['joining', 'active', 'draining'] as const;
export type IngressGroupMemberState = (typeof INGRESS_GROUP_MEMBER_STATES)[number];

/**
 * Ordered members of an ingress group. `priority` is the site preference (0 first); the first member is the group's
 * primary, mirrored into `proxy_hosts.node_id` and `domains.nginx_node_id` of the group's routes and domains so code
 * that needs one node (logs, folder grants, legacy daemons) keeps a stable answer. A node may be in several groups.
 */
export const ingressGroupMembers = pgTable(
  'ingress_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => ingressGroups.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    priority: integer('priority').notNull().default(0),
    state: varchar('state', { length: 16 }).$type<IngressGroupMemberState>().notNull().default('active'),
    drainStartedAt: timestamp('drain_started_at', { withTimezone: true }),
    /** Why the member is not settled yet (a join that did not reach it, a drain waiting for DNS), for views. */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.groupId, table.nodeId], name: 'ingress_group_members_pkey' }),
    nodeIdx: index('ingress_group_members_node_idx').on(table.nodeId),
    orderIdx: index('ingress_group_members_order_idx').on(table.groupId, table.priority),
    stateValid: check('ingress_group_members_state_valid', sql`${table.state} IN ('joining', 'active', 'draining')`),
    drainConsistent: check(
      'ingress_group_members_drain_consistent',
      sql`(${table.state} = 'draining') = (${table.drainStartedAt} IS NOT NULL)`
    ),
  })
);

/**
 * Per-member delivery state of a group route: the config and certificate version Opfield wants on each member and
 * what the member confirmed. A member that was offline keeps `pending` and converges on reconnect or through the
 * convergence reconciler. Single-node routes keep using `nginx_proxy_host_deployments` only.
 */
export const ingressMemberDeliveries = pgTable(
  'ingress_member_deliveries',
  {
    // Not a schema-level foreign key for the same reason as nginx_proxy_host_deployments (legacy import cycle);
    // rows are removed with the host and when a member leaves.
    hostId: uuid('host_id').notNull(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    desiredConfigHash: varchar('desired_config_hash', { length: 64 }),
    appliedConfigHash: varchar('applied_config_hash', { length: 64 }),
    desiredCertificateVersion: varchar('desired_certificate_version', { length: 128 }),
    appliedCertificateVersion: varchar('applied_certificate_version', { length: 128 }),
    status: varchar('status', { length: 16 }).$type<'pending' | 'ready' | 'failed'>().notNull().default('pending'),
    lastError: text('last_error'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.hostId, table.nodeId], name: 'ingress_member_deliveries_pkey' }),
    nodeStatusIdx: index('ingress_member_deliveries_node_status_idx').on(table.nodeId, table.status),
    statusCheck: check(
      'ingress_member_deliveries_status_check',
      sql`${table.status} IN ('pending', 'ready', 'failed')`
    ),
  })
);
