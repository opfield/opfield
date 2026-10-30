import { boolean, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { dockerDeployments } from './docker-deployments.js';
import { nodes } from './nodes.js';
import { users } from './users.js';

export const dockerWebhooks = pgTable(
  'docker_webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    containerName: text('container_name').notNull(),
    targetType: text('target_type').$type<'container' | 'deployment'>().notNull().default('container'),
    deploymentId: uuid('deployment_id').references(() => dockerDeployments.id, { onDelete: 'cascade' }),
    /**
     * Legacy plaintext token, null once sealed. The default stays so a writer that still inserts a webhook without
     * `tokenHash` gets a usable token; DockerWebhookService seals it when it returns it or on first use.
     */
    token: uuid('token').defaultRandom(),
    /** SHA-256 (hex) of the token in the webhook URL; incoming webhook calls are matched by it. */
    tokenHash: text('token_hash'),
    /**
     * The token encrypted with the installation's secret key (CryptoService.encryptString, JSON), so the URL can be
     * shown again. Null for a webhook that 2.13.0 reduced to its hash: that URL works but cannot be shown.
     */
    tokenEncrypted: text('token_encrypted'),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * The account that created the webhook, and the one that last changed it (enable, disable, token rotation). A
     * webhook call that gives a workload with host bind mounts a new image acts for `updatedById`, checked against
     * its current docker:containers:mounts permission. Webhooks saved before these columns have null here.
     */
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('docker_webhooks_node_id_container_name_unique').on(table.nodeId, table.containerName),
    uniqueIndex('docker_webhooks_token_idx').on(table.token),
    uniqueIndex('docker_webhooks_token_hash_idx').on(table.tokenHash),
  ]
);
