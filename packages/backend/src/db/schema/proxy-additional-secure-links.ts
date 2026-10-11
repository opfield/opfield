import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { dockerComposeProjects } from './docker-compose.js';
import { dockerDeployments } from './docker-deployments.js';
import { managedStorageClusters } from './managed-storage.js';
import { nodes } from './nodes.js';
import { forwardSchemeEnum, proxyHosts, proxyUpstreamKindEnum } from './proxy-hosts.js';

export const proxyAdditionalSecureLinks = pgTable(
  'proxy_additional_secure_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proxyHostId: uuid('proxy_host_id')
      .notNull()
      .references(() => proxyHosts.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    // User-created Advanced bindings and Additional Route bindings share the
    // same relay/listener projection.  The purpose/reference pair is an
    // internal ownership boundary: user-facing Advanced surfaces must only
    // read `user_managed` rows, while route and Availability runtimes read
    // their hidden purpose rows by reference id.
    purpose: varchar('purpose', { length: 32 })
      .$type<'user_managed' | 'additional_route' | 'availability_member'>()
      .notNull()
      .default('user_managed'),
    referenceId: uuid('reference_id'),
    availabilityOwnerKey: text('availability_owner_key'),
    // Availability members of standby placements (D7): provisioned end to end, but the nginx daemon keeps the
    // socket closed until the member's candidate holds the lease, and it is never probed.
    dormant: boolean('dormant').notNull().default(false),
    // The app kill switch incident that holds this link closed (Apps): sources and the target leave it out of their
    // sync sets until the incident is released. Independent of Availability's dormant flag.
    incidentSuspendedBy: uuid('incident_suspended_by'),
    upstreamKind: proxyUpstreamKindEnum('upstream_kind').notNull(),
    forwardScheme: forwardSchemeEnum('forward_scheme').notNull().default('http'),
    sourceNodeId: uuid('source_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    dockerNodeId: uuid('docker_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    dockerContainerName: varchar('docker_container_name', { length: 255 }),
    dockerComposeProjectId: uuid('docker_compose_project_id').references(() => dockerComposeProjects.id, {
      onDelete: 'restrict',
    }),
    dockerComposeServiceName: varchar('docker_compose_service_name', { length: 255 }),
    dockerDeploymentId: uuid('docker_deployment_id').references(() => dockerDeployments.id, {
      onDelete: 'restrict',
    }),
    managedStorageId: uuid('managed_storage_id').references(() => managedStorageClusters.id, {
      onDelete: 'restrict',
    }),
    dockerContainerPort: integer('docker_container_port').notNull(),
    dockerHostPort: integer('docker_host_port').notNull(),
    targetNetwork: varchar('target_network', { length: 255 }).notNull().default(''),
    targetContainer: varchar('target_container', { length: 255 }).notNull(),
    generation: integer('generation').notNull().default(1),
    status: varchar('status', { length: 32 }).notNull().default('provisioning'),
    lastError: text('last_error'),
    listenerPort: integer('listener_port'),
    // The link's loopback TCP address on its nginx nodes (secureLinkLoopbackAddress); unique across both link tables.
    loopbackSlot: integer('loopback_slot').notNull().default(sql`nextval('secure_link_loopback_slot_seq')`),
    connectorPort: integer('connector_port'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    purposeCheck: check(
      'proxy_additional_secure_links_purpose_check',
      sql`${table.purpose} in ('user_managed', 'additional_route', 'availability_member')`
    ),
    availabilityOwnerCheck: check(
      'proxy_additional_secure_links_availability_owner_check',
      sql`(${table.purpose} = 'availability_member' AND ${table.availabilityOwnerKey} IS NOT NULL AND ${table.referenceId} IS NOT NULL)
        OR (${table.purpose} <> 'availability_member' AND ${table.availabilityOwnerKey} IS NULL)`
    ),
    dormantCheck: check(
      'proxy_additional_secure_links_dormant_check',
      sql`NOT ${table.dormant} OR ${table.purpose} = 'availability_member'`
    ),
    hostNameUnique: unique('proxy_additional_secure_links_host_name_unique').on(table.proxyHostId, table.name),
    hostIdx: index('proxy_additional_secure_links_host_idx').on(table.proxyHostId),
    loopbackSlotUnique: uniqueIndex('proxy_additional_secure_links_loopback_slot_unique').on(table.loopbackSlot),
    purposeReferenceIdx: index('proxy_additional_secure_links_purpose_reference_idx').on(
      table.purpose,
      table.referenceId
    ),
    availabilityOwnerIdx: index('proxy_additional_secure_links_availability_owner_idx').on(
      table.availabilityOwnerKey,
      table.referenceId
    ),
    availabilityOwnerUnique: uniqueIndex('proxy_additional_secure_links_availability_owner_unique')
      .on(table.proxyHostId, table.availabilityOwnerKey, table.referenceId)
      .where(sql`${table.purpose} = 'availability_member'`),
    sourceNodeIdx: index('proxy_additional_secure_links_source_node_idx').on(table.sourceNodeId),
    targetNodeIdx: index('proxy_additional_secure_links_target_node_idx').on(table.dockerNodeId),
    dockerComposeProjectIdx: index('proxy_additional_secure_links_docker_compose_project_idx').on(
      table.dockerComposeProjectId
    ),
    statusIdx: index('proxy_additional_secure_links_status_idx').on(table.status),
  })
);
