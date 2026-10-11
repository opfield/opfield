import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { dockerAvailabilityPlacements } from './docker-availability.js';
import { nodes } from './nodes.js';
import { users } from './users.js';

/** The workload a container link starts from (its consumer) or leads to (its target). */
export type ContainerLinkWorkloadType = 'container' | 'deployment' | 'compose_service';

/** Optional variables the consumer gets; setting any of them recreates the consumer once. */
export interface ContainerLinkEnvironment {
  host?: string;
  port?: string;
  url?: string;
}

export type ContainerLinkDesiredState = 'active' | 'suspended' | 'deleted';

/**
 * `creating`: being provisioned. `ready`: the consumer reaches the target. `waiting`: the target does not run; the
 * link refuses connections until it does. `pending`: saved on the consumer, which takes it with its next start,
 * rollout or revision. `update_required`: a node lacks `secure_link_egress_v1`. `error`: see lastError.
 */
export type ContainerLinkStatus =
  | 'creating'
  | 'ready'
  | 'waiting'
  | 'pending'
  | 'update_required'
  | 'error'
  | 'deleting';

/**
 * A private TCP path from a consumer workload to one port of a target workload, served by the shared secure-link
 * connector on both nodes: the consumer reaches `alias:targetPort` on the link network `gateway-link-<16 hex>`, the
 * target needs no published port and no route.
 */
export const containerLinks = pgTable(
  'container_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceNodeId: uuid('source_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    sourceType: varchar('source_type', { length: 32 }).$type<ContainerLinkWorkloadType>().notNull(),
    sourceResourceId: varchar('source_resource_id', { length: 255 }).notNull(),
    targetNodeId: uuid('target_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    targetType: varchar('target_type', { length: 32 }).$type<ContainerLinkWorkloadType>().notNull(),
    targetResourceId: varchar('target_resource_id', { length: 255 }).notNull(),
    targetPort: integer('target_port').notNull(),
    alias: varchar('alias', { length: 63 }).notNull(),
    environment: jsonb('environment').$type<ContainerLinkEnvironment>().notNull().default({}),
    networkName: varchar('network_name', { length: 128 }).notNull(),
    // What the target-side connector binding dials, as the target node resolved it (a deployment's router, a Compose
    // service's container). `generation` moves when it changes, like a proxy Secure Link's.
    targetContainer: varchar('target_container', { length: 255 }),
    targetNetwork: varchar('target_network', { length: 128 }),
    targetDialPort: integer('target_dial_port'),
    generation: integer('generation').notNull().default(1),
    // The link generation a container consumer was last recreated for to take the link's variables: one recreate per
    // generation at most, so a check that cannot see the variables never recreates it over and over.
    consumerRecreatedGeneration: integer('consumer_recreated_generation'),
    desiredState: varchar('desired_state', { length: 32 })
      .$type<ContainerLinkDesiredState>()
      .notNull()
      .default('active'),
    status: varchar('status', { length: 32 }).$type<ContainerLinkStatus>().notNull().default('creating'),
    lastError: text('last_error'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceIdx: index('container_links_source_idx').on(table.sourceNodeId, table.sourceType, table.sourceResourceId),
    targetIdx: index('container_links_target_idx').on(table.targetNodeId, table.targetType, table.targetResourceId),
    sourceAliasUnique: unique('container_links_source_alias_unique').on(
      table.sourceNodeId,
      table.sourceType,
      table.sourceResourceId,
      table.alias
    ),
  })
);

/**
 * Node-local parts of a container link whose workload Availability runs on several nodes. `source`: a placement of the
 * consumer runs the link from its node (the link network there and the link's route from that node). `target`: a
 * placement of the target serves the link on its node (a connector binding, owner of its own relay endpoint).
 */
export const containerLinkPlacements = pgTable(
  'container_link_placements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => containerLinks.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).$type<'source' | 'target'>().notNull(),
    availabilityPlacementId: uuid('availability_placement_id').references(() => dockerAvailabilityPlacements.id, {
      onDelete: 'cascade',
    }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    targetContainer: varchar('target_container', { length: 255 }),
    targetNetwork: varchar('target_network', { length: 128 }),
    targetDialPort: integer('target_dial_port'),
    generation: integer('generation').notNull().default(1),
    status: varchar('status', { length: 32 }).$type<ContainerLinkStatus>().notNull().default('creating'),
    lastError: text('last_error'),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    placementUnique: unique('container_link_placements_placement_unique').on(
      table.linkId,
      table.role,
      table.availabilityPlacementId
    ),
    linkIdx: index('container_link_placements_link_idx').on(table.linkId),
    nodeIdx: index('container_link_placements_node_idx').on(table.nodeId),
  })
);

export type ContainerLinkRow = typeof containerLinks.$inferSelect;
export type ContainerLinkPlacementRow = typeof containerLinkPlacements.$inferSelect;
