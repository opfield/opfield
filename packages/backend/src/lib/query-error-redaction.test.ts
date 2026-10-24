import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { placeholderColumns, redactQueryError, redactQueryErrorsDeep } from './query-error-redaction.js';

const NODE_INSERT =
  'insert into "nodes" ("id", "type", "hostname", "display_name", "slug", "enrollment_token_selector", "enrollment_token_hash", "status", "metadata") values (default, $1, $2, $3, $4, $5, $6, $7, $8) returning "id"';
const PARAMS = ['docker', 'mx-d2', 'mx-d2', 'mx-d2', 'sel_abc123', '$2b$10$hashhashhash', 'pending', '{"a":1}'];

describe('failed query redaction', () => {
  it('maps insert and comparison placeholders to their columns', () => {
    const columns = placeholderColumns(NODE_INSERT);
    expect(columns.get(5)).toBe('enrollment_token_selector');
    expect(columns.get(6)).toBe('enrollment_token_hash');
    expect(columns.get(1)).toBe('type');
    const update = placeholderColumns('update "users" set "password_hash" = $1, "name" = $2 where "users"."id" = $3');
    expect([...update]).toEqual([
      [1, 'password_hash'],
      [2, 'name'],
      [3, 'id'],
    ]);
  });

  it('removes credential values from the message, stack and params of a Drizzle query error', () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "nodes_slug_unique"'), {
      code: '23505',
    });
    const error = new DrizzleQueryError(NODE_INSERT, PARAMS, cause);
    const redacted = redactQueryError(error);
    for (const text of [redacted.message, redacted.stack ?? '', JSON.stringify(redacted.params)]) {
      expect(text).not.toContain('sel_abc123');
      expect(text).not.toContain('$2b$10$hashhashhash');
    }
    expect(redacted.message).toContain('mx-d2');
    expect(redacted.params).toEqual([
      'docker',
      'mx-d2',
      'mx-d2',
      'mx-d2',
      '[redacted]',
      '[redacted]',
      'pending',
      '{"a":1}',
    ]);
    expect(redacted.cause).toBe(cause);
    // The original error is left as it is for the code that handles it.
    expect(error.params).toBe(PARAMS);
  });

  it('drops every bound value from a failed query copied into a string', () => {
    const text = `Failed query: ${NODE_INSERT}\nparams: ${PARAMS.join(',')}`;
    const redacted = redactQueryErrorsDeep({ error: { message: text } }) as { error: { message: string } };
    expect(redacted.error.message).toContain('Failed query: insert into "nodes"');
    expect(redacted.error.message).not.toContain('sel_abc123');
  });
});
