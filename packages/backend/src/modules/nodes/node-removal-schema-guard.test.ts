import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '@/db/schema/index.js';
import {
  NODE_REFERENCE_BLOCKERS,
  NODE_REMOVAL_CLEANED_REFERENCES,
  NODE_REMOVAL_SERVICE_CHECKED_REFERENCES,
} from './node-removal-references.js';

/**
 * A foreign key to nodes.id that restricts (or has no action on) the delete turns node removal into a raw
 * `Failed query: delete from "nodes"` error. Every such column must be handled on purpose.
 */
describe('node deletion covers every foreign key to nodes', () => {
  const handled = new Set<string>();
  for (const blocker of NODE_REFERENCE_BLOCKERS) {
    for (const column of blocker.columns) {
      handled.add(`${getTableConfig(blocker.table).name}.${column.name}`);
    }
  }
  for (const entry of [...NODE_REMOVAL_CLEANED_REFERENCES, ...NODE_REMOVAL_SERVICE_CHECKED_REFERENCES]) {
    handled.add(`${entry.table}.${entry.column}`);
  }

  const references: Array<{ key: string; onDelete: string | undefined }> = [];
  for (const exported of Object.values(schema)) {
    if (!(exported instanceof PgTable)) continue;
    const config = getTableConfig(exported);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      if (getTableConfig(reference.foreignTable).name !== 'nodes') continue;
      for (const column of reference.columns) {
        references.push({ key: `${config.name}.${column.name}`, onDelete: foreignKey.onDelete });
      }
    }
  }

  it('finds the foreign keys to nodes in the schema', () => {
    expect(references.length).toBeGreaterThan(30);
  });

  it('cascades, clears or handles with a typed error every other foreign key', () => {
    const uncovered = references
      .filter(({ onDelete }) => onDelete !== 'cascade' && onDelete !== 'set null')
      .filter(({ key }) => !handled.has(key))
      .map(({ key, onDelete }) => `${key} (on delete ${onDelete ?? 'no action'})`);

    expect(
      uncovered,
      `Deleting a node fails with a raw foreign key error for: ${uncovered.join(', ')}. Make each one ON DELETE CASCADE / SET NULL with a migration, ` +
        'or add it to NODE_REFERENCE_BLOCKERS (typed 409 while real resources use the node) or to prepareNodeRemoval and ' +
        'NODE_REMOVAL_CLEANED_REFERENCES (stale state removed with the node) in node-removal-references.ts.'
    ).toEqual([]);
  });

  it('lists only columns that really reference nodes', () => {
    const known = new Set(references.map(({ key }) => key));
    const stale = [...handled].filter((key) => !known.has(key));

    expect(stale, `Listed in node-removal-references.ts but no foreign key to nodes: ${stale.join(', ')}`).toEqual([]);
  });
});
