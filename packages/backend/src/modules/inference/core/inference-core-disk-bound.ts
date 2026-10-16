// What the inference core writes without a bound, and the scripts that keep it bounded (inference-core-runtime).

/**
 * The core appends one line per request to usage.jsonl and never trims it. It reads at most the newest 64 MiB of it
 * (usage views, the routing history it rebuilds when the file shrinks), and Opfield keeps its own accounting, so the
 * file is cut to its newest 64 MiB once it passes 128 MiB.
 */
export const CORE_USAGE_LOG_MAX_BYTES = 128 * 1024 * 1024;
export const CORE_USAGE_LOG_KEEP_BYTES = 64 * 1024 * 1024;
/** A core container created before its log rotated: the log keeps its newest 10 MiB once it passes 150 MiB. */
export const UNROTATED_CORE_LOG_MAX_BYTES = 150 * 1024 * 1024;
export const UNROTATED_CORE_LOG_KEEP_BYTES = 10 * 1024 * 1024;

/**
 * A POSIX shell script that keeps the newest keepBytes (from a whole line) of file once it is over maxBytes and
 * prints `trimmed <before> <after>`. `replace` writes the kept part to a new file the writer's next append-open
 * finds (the core opens usage.jsonl for each line); `in-place` truncates the file and appends the kept part, for a
 * file a writer holds open O_APPEND (Docker's json log).
 */
export function trimFileScript(
  file: string,
  maxBytes: number,
  keepBytes: number,
  mode: 'replace' | 'in-place'
): string {
  const quoted = `'${file.replaceAll("'", "'\\''")}'`;
  const keep =
    mode === 'replace'
      ? `tail -c ${keepBytes} "$f" | tail -n +2 > "$f.opfield-trim" && chown --reference="$f" "$f.opfield-trim" 2>/dev/null; chmod 600 "$f.opfield-trim" && mv -f "$f.opfield-trim" "$f"`
      : `tail -c ${keepBytes} "$f" | tail -n +2 > /tmp/opfield-trim && : > "$f" && cat /tmp/opfield-trim >> "$f" && rm -f /tmp/opfield-trim`;
  return [
    `f=${quoted}`,
    '[ -f "$f" ] || exit 0',
    'before=$(wc -c < "$f")',
    `[ "$before" -gt ${maxBytes} ] || exit 0`,
    `${keep} || exit 1`,
    'echo "trimmed $before $(wc -c < "$f")"',
  ].join('\n');
}
