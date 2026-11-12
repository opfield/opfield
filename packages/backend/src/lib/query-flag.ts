function readFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return undefined;
}

/**
 * A boolean query parameter: true/false/1/0 in any letter case. z.coerce.boolean() cannot read one: it is
 * Boolean(value), so `?enabled=false` is the non-empty string "false", which is true. Any other value is left as it
 * came, so z.boolean() refuses it with 400 instead of guessing.
 */
export function queryFlag(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  return readFlag(value) ?? value;
}

/** The app-membership filter has always read an unknown value as false; released clients may rely on it. */
export function queryFlagOrFalse(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return readFlag(value) ?? false;
}
