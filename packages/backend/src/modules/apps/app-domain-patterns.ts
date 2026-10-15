/**
 * Domain allowlist patterns of apps and environments. A pattern is an exact name (`api.example.com`) or `*.<domain>`
 * for any name at any depth under that domain (`*.example.com` does not match `example.com` itself). Patterns and
 * names compare case-insensitively, trimmed and without a trailing dot.
 */

export const MAX_DOMAIN_PATTERNS = 100;

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const PATTERN_RE = new RegExp(`^(\\*\\.)?(${LABEL}\\.)+[a-z]{2,63}$`);

export function normalizeDomainName(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

/** Whether a normalized value is a valid pattern (exact name or `*.<domain>`). */
export function isValidDomainPattern(value: string): boolean {
  return value.length <= 253 && PATTERN_RE.test(value);
}

/** Normalized, de-duplicated patterns in their given order (invalid entries are the caller's to refuse first). */
export function normalizeDomainPatterns(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeDomainName).filter((value) => value.length > 0))];
}

/** Entries of `values` that are not valid patterns once normalized (empty entries are ignored). */
export function invalidDomainPatterns(values: readonly string[]): string[] {
  return values.filter((value) => {
    const normalized = normalizeDomainName(value);
    return normalized.length > 0 && !isValidDomainPattern(normalized);
  });
}

export function domainMatchesPattern(name: string, pattern: string): boolean {
  const normalized = normalizeDomainName(name);
  // `*.example.com` matches every name ending in `.example.com`, a wildcard name such as `*.api.example.com` too.
  if (pattern.startsWith('*.')) return normalized.endsWith(pattern.slice(1));
  return normalized === pattern;
}

/** An empty list allows every name. */
export function isDomainAllowed(name: string, patterns: readonly string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => domainMatchesPattern(name, pattern));
}

/** App-wide and environment patterns joined (the environment's effective list). */
export function effectiveDomainPatterns(appPatterns: readonly string[], envPatterns: readonly string[]): string[] {
  return normalizeDomainPatterns([...appPatterns, ...envPatterns]);
}
