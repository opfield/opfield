import { jsonb, pgTable, timestamp } from 'drizzle-orm/pg-core';

/**
 * One row per minute of Gateway's own diagnostics (host, process, API, Postgres, Redis, stack
 * containers). The diagnostics sampler writes them and keeps 48 hours.
 */
export const opfieldDiagnosticsSamples = pgTable('opfield_diagnostics_samples', {
  minute: timestamp('minute', { withTimezone: true }).primaryKey(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
});
