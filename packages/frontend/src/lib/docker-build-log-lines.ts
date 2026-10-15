export interface DockerBuildLogChunkLike {
  sequence: number;
  content: string;
}

export interface DockerBuildLogLine {
  /** Stable across refreshes: the sequence of the chunk where the line starts, plus its index in that chunk. */
  key: string;
  content: string;
}

/**
 * The docker daemon emits build output in chunks cut at arbitrary byte boundaries, so one
 * output line can span several chunks. This joins the chunks in sequence order and splits
 * the result on "\n". The unfinished tail stays a line of its own and is completed when the
 * next chunk arrives, because the lines are always rebuilt from the whole chunk list.
 */
export function joinDockerBuildLogChunks(
  chunks: readonly DockerBuildLogChunkLike[]
): DockerBuildLogLine[] {
  const ordered = [...chunks].sort((a, b) => a.sequence - b.sequence);
  const lines: DockerBuildLogLine[] = [];
  let pending = "";
  let pendingKey = "";
  let previousSequence: number | null = null;

  for (const chunk of ordered) {
    if (chunk.sequence === previousSequence) continue;
    previousSequence = chunk.sequence;
    let startedInChunk = 0;
    const parts = chunk.content.split("\n");
    for (let index = 0; index < parts.length; index++) {
      if (pendingKey === "") pendingKey = `${chunk.sequence}:${startedInChunk++}`;
      pending += parts[index];
      if (index < parts.length - 1) {
        lines.push({ key: pendingKey, content: visibleLineContent(pending) });
        pending = "";
        pendingKey = "";
      }
    }
    // A chunk that ended on "\n" leaves an empty tail that has not started a line yet.
    if (pending === "") pendingKey = "";
  }
  if (pendingKey !== "") lines.push({ key: pendingKey, content: visibleLineContent(pending) });
  return lines;
}

/** "\r\n" ends a line like "\n"; a bare "\r" rewrites the line, so the last non-empty segment wins. */
function visibleLineContent(raw: string): string {
  const segments = raw.split("\r");
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (segment) return segment;
  }
  return "";
}
