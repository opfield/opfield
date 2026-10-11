import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { appEnvironments, apps } from './apps.js';
import { users } from './users.js';

export type AppPromotionStatus = 'running' | 'succeeded' | 'partial' | 'failed';
export type AppPromotionItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

/** One promoted pair: the source member, its target, what runs in each and how it went. */
export interface AppPromotionItemRecord {
  pairKey: string;
  type: 'container' | 'deployment' | 'compose' | 'pages';
  sourceId: string;
  sourceName: string;
  sourceNodeId: string | null;
  targetId: string;
  targetName: string;
  targetNodeId: string | null;
  from: string | null;
  to: string;
  status: AppPromotionItemStatus;
  detail: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * A promotion runs in the target environment exactly what runs in the source: image digests (never rebuilt), Git
 * artifacts by digest, Compose revisions with pinned images, Pages artifacts. Items run one after another and each
 * succeeds or fails on its own; nothing is rolled back.
 */
export const appPromotions = pgTable(
  'app_promotions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    sourceEnvironmentId: uuid('source_environment_id')
      .notNull()
      .references(() => appEnvironments.id, { onDelete: 'cascade' }),
    targetEnvironmentId: uuid('target_environment_id')
      .notNull()
      .references(() => appEnvironments.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).$type<AppPromotionStatus>().notNull().default('running'),
    previewDigest: text('preview_digest').notNull(),
    items: jsonb('items').$type<AppPromotionItemRecord[]>().notNull().default([]),
    startedById: uuid('started_by_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('app_promotions_app_started_idx').on(table.appId, table.startedAt),
    index('app_promotions_target_started_idx').on(table.targetEnvironmentId, table.startedAt),
  ]
);

export type AppPromotion = typeof appPromotions.$inferSelect;
