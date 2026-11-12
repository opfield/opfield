import { describe, expect, it } from 'vitest';
import { RedisSetKeySchema } from './databases.schemas.js';

const body = (type: string, value: unknown) => ({ key: 'k', type, value });

// The write deletes the key first: a value that writes nothing must never reach it (an empty zset deleted the key,
// and the read of the result then answered 404).
describe('writing a key of a key-value store', () => {
  it.each([
    ['string', 'text'],
    ['string', 5],
    ['hash', { field: 'value', count: 1 }],
    ['list', ['a', 1]],
    ['set', ['a']],
    ['zset', [{ member: 'a', score: 1.5 }]],
    // Shapes released clients already send, which the writer has always stored.
    ['string', { nested: true }],
    ['hash', ['field', 'value']],
    ['list', [null]],
    ['zset', [{ member: 'a', score: '1.5' }]],
    ['zset', [{ member: 'a', score: '-inf' }]],
    ['zset', [{ member: 5 }]],
  ])('takes a %s value', (type, value) => {
    expect(RedisSetKeySchema.safeParse(body(type, value)).success).toBe(true);
  });

  it.each([
    ['hash', 'text'],
    ['hash', {}],
    ['hash', []],
    ['hash', ['field']],
    ['list', 'text'],
    ['list', []],
    ['set', {}],
    ['set', []],
    ['zset', 'text'],
    ['zset', []],
    ['zset', [{ member: 'a', score: 'high' }]],
    ['zset', [{ member: 'a', score: true }]],
    ['zset', [null]],
  ])('refuses a %s value that would delete the key or fail the write: %j', (type, value) => {
    const parsed = RedisSetKeySchema.safeParse(body(type, value));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path[0]).toBe('value');
  });
});
