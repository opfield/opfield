/**
 * A boolean query parameter. z.coerce.boolean() cannot read one: it is Boolean(value), so `?enabled=false` is the
 * non-empty string "false", which is true.
 */
export function queryFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return value === true || value === 'true' || value === '1';
}
