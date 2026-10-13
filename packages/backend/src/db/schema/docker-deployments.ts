import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';
import { users } from './users.js';

export type DockerDeploymentSlot = 'blue' | 'green';
export type DockerDeploymentStatus =
  | 'creating'
  | 'ready'
  | 'deploying'
  | 'switching'
  | 'degraded'
  | 'failed'
  | 'stopped'
  | 'deleting';

export interface DockerDeploymentHealthConfig {
  path: string;
  statusMin: number;
  statusMax: number;
  timeoutSeconds: number;
  intervalSeconds: number;
  successThreshold: number;
  startupGraceSeconds: number;
  deployTimeoutSeconds: number;
}

export interface DockerDeploymentDesiredConfig {
  image: string;
  env?: Record<string, string>;
  mounts?: Array<{ hostPath?: string; containerPath: string; name?: string; readOnly?: boolean }>;
  command?: string[];
  entrypoint?: string[];
  workingDir?: string;
  user?: string;
  labels?: Record<string, string>;
  /** Internal, Opfield-owned private networks (for managed database connectors). */
  networks?: string[];
  restartPolicy?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  runtimeProfile?: 'default' | 'secure';
  runtime?: Record<string, unknown>;
  gpu?: { deviceIds: string[] };
}

export const dockerDeployments = pgTable(
  'docker_deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    desiredConfig: jsonb('desired_config').$type<DockerDeploymentDesiredConfig>().notNull(),
    activeSlot: text('active_slot').$type<DockerDeploymentSlot>().notNull().default('blue'),
    status: text('status').$type<DockerDeploymentStatus>().notNull().default('creating'),
    routerName: text('router_name').notNull(),
    routerImage: text('router_image').notNull().default('nginx:alpine'),
    networkName: text('network_name').notNull(),
    healthConfig: jsonb('health_config').$type<DockerDeploymentHealthConfig>().notNull(),
    drainSeconds: integer('drain_seconds').notNull().default(30),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('docker_deployments_node_id_name_unique').on(table.nodeId, table.name),
    index('docker_deployments_node_id_idx').on(table.nodeId),
  ]
);

export const dockerDeploymentRoutes = pgTable(
  'docker_deployment_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => dockerDeployments.id, { onDelete: 'cascade' }),
    hostPort: integer('host_port').notNull(),
    containerPort: integer('container_port').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('docker_deployment_routes_deployment_host_port_unique').on(table.deploymentId, table.hostPort),
    index('docker_deployment_routes_deployment_id_idx').on(table.deploymentId),
  ]
);

export const dockerDeploymentSlots = pgTable(
  'docker_deployment_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => dockerDeployments.id, { onDelete: 'cascade' }),
    slot: text('slot').$type<DockerDeploymentSlot>().notNull(),
    containerId: text('container_id'),
    containerName: text('container_name').notNull(),
    image: text('image'),
    desiredConfig: jsonb('desired_config').$type<DockerDeploymentDesiredConfig>(),
    status: text('status').notNull().default('empty'),
    health: text('health').notNull().default('unknown'),
    drainingUntil: timestamp('draining_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('docker_deployment_slots_deployment_slot_unique').on(table.deploymentId, table.slot),
    index('docker_deployment_slots_deployment_id_idx').on(table.deploymentId),
  ]
);

export const dockerDeploymentReleases = pgTable(
  'docker_deployment_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => dockerDeployments.id, { onDelete: 'cascade' }),
    fromSlot: text('from_slot').$type<DockerDeploymentSlot>(),
    toSlot: text('to_slot').$type<DockerDeploymentSlot>(),
    image: text('image'),
    triggerSource: text('trigger_source').notNull().default('manual'),
    taskId: uuid('task_id'),
    status: text('status').notNull().default('running'),
    error: text('error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('docker_deployment_releases_deployment_id_idx').on(table.deploymentId)]
);
