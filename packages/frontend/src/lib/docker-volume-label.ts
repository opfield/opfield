/** Docker names an anonymous volume with 64 hex characters. */
const ANONYMOUS_VOLUME_RE = /^[a-f0-9]{64}$/i;
const ANONYMOUS_PREFIX_LENGTH = 8;

export function isAnonymousVolumeName(name: string | null | undefined): boolean {
  return ANONYMOUS_VOLUME_RE.test((name ?? "").trim());
}

/**
 * How lists, mounts, pickers and AI resource links name a volume. A named volume is its name. An anonymous one is
 * "Anonymous volume 5eb8af45…", plus the container it belongs to when known; the full name goes in the hover text.
 * `full` keeps the whole 64-character name, without the owner, for wide rows that truncate by available width.
 */
export function dockerVolumeLabel(
  name: string,
  owner?: string | null
): { text: string; full: string; title: string; anonymous: boolean } {
  const value = name.trim();
  if (!isAnonymousVolumeName(value)) {
    return { text: value, full: value, title: value, anonymous: false };
  }
  const short = `Anonymous volume ${value.slice(0, ANONYMOUS_PREFIX_LENGTH)}…`;
  return {
    text: owner ? `${short} · ${owner}` : short,
    full: `Anonymous volume ${value}`,
    title: value,
    anonymous: true,
  };
}

/** The container an anonymous volume belongs to: the only container using it. */
export function anonymousVolumeOwner(usedBy: readonly string[] | null | undefined): string | null {
  return usedBy && usedBy.length === 1 ? (usedBy[0] ?? "").replace(/^\//, "") || null : null;
}
