/**
 * Objects on a node still under their pre-Opfield names, by kind, as a 2.12.1+ daemon reports them in
 * HealthReport.legacy_names. Only positive whole counts are kept; null when there are none, so the stored report omits
 * the field. Shown on the node page; nothing is gated on it in 2.12.1.
 */
export function legacyNameCounts(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const counts: Record<string, number> = {};
  for (const [kind, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = Number(raw);
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(kind) || !Number.isSafeInteger(count) || count <= 0) continue;
    counts[kind] = count;
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

/** All objects a node still keeps under previous names. */
export function legacyNameTotal(counts: Record<string, number> | null | undefined): number {
  return counts ? Object.values(counts).reduce((total, count) => total + count, 0) : 0;
}
