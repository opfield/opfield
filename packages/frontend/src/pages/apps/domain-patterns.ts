// Allowed domains of an app and its environments (the server validates and normalizes them too).

export const DOMAIN_PATTERN_PLACEHOLDER = "api.example.com or *.example.com";

/** Rows of the editor as the list to save: trimmed, lowercase, no trailing dot, no empty or repeated rows. */
export function domainPatternDraft(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => value.trim().toLowerCase().replace(/\.+$/, "")).filter(Boolean)
    ),
  ];
}

export function sameDomainPatterns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
