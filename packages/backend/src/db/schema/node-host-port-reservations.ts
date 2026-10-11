import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';

export type NodeHostPortProtocol = 'tcp' | 'udp';
export type NodeHostPortOwnerKind =
  | 'deployment'
  | 'deployment_replica'
  | 'managed_storage'
  | 'managed_database'
  | 'app_incident';

/**
 * One host port a Gateway-managed workload holds on its node. The partial
 * unique index is the guarantee that two workloads never reserve the same
 * port; the owner tables keep these rows in sync through triggers (migration
 * 0207), so an owner's write fails with a unique violation instead of the
 * daemon failing to bind later.
 *
 * `conflict` marks a reservation recorded although another owner already held
 * the port: collisions that existed before this table, and ports a daemon
 * picked or a migrated workload already binds. Those rows stay outside the
 * unique index, and a new reservation of the port is still refused.
 *
 * `pending_until` marks a hold (migration 0209): a port kept for a change in
 * flight, such as the new ports of a route change before the router moves or
 * the old port of a database move until the daemon confirms it. The owner's
 * triggers leave holds alone; the change settles them, and the periodic
 * reconcile releases holds past `pending_until` that no binding explains.
 *
 * Owner kinds: a blue/green deployment on its own node, an Availability
 * replica of one (`deployment_replica`, keyed by placement) on every other
 * node it is placed on, a managed storage cluster and a managed database. `app_incident` (keyed by the incident item)
 * keeps the published port of a managed database or storage whose publication an app kill switch suspended, so the
 * same port is republished on release.
 */
export const nodeHostPortReservations = pgTable(
  'node_host_port_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    protocol: varchar('protocol', { length: 8 }).$type<NodeHostPortProtocol>().notNull().default('tcp'),
    hostPort: integer('host_port').notNull(),
    ownerKind: varchar('owner_kind', { length: 32 }).$type<NodeHostPortOwnerKind>().notNull(),
    ownerId: uuid('owner_id').notNull(),
    conflict: boolean('conflict').notNull().default(false),
    pendingUntil: timestamp('pending_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('node_host_port_reservations_port_unique')
      .on(table.nodeId, table.protocol, table.hostPort)
      .where(sql`${table.conflict} = false`),
    // Every lookup by port, conflicting rows included (the unique index above is partial).
    index('node_host_port_reservations_node_port_idx').on(table.nodeId, table.protocol, table.hostPort),
    index('node_host_port_reservations_pending_idx')
      .on(table.pendingUntil)
      .where(sql`${table.pendingUntil} IS NOT NULL`),
    uniqueIndex('node_host_port_reservations_owner_port_unique').on(
      table.ownerKind,
      table.ownerId,
      table.protocol,
      table.hostPort
    ),
    check('node_host_port_reservations_protocol_valid', sql`${table.protocol} IN ('tcp', 'udp')`),
    check('node_host_port_reservations_port_valid', sql`${table.hostPort} BETWEEN 1 AND 65535`),
    check(
      'node_host_port_reservations_owner_kind_valid',
      sql`${table.ownerKind} IN ('deployment', 'deployment_replica', 'managed_storage', 'managed_database', 'app_incident')`
    ),
  ]
);

export type NodeHostPortReservationRow = typeof nodeHostPortReservations.$inferSelect;
