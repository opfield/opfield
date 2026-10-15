/**
 * The core answers with the model id Opfield sent it — its internal route id
 * (`core-<connectionId>/<model>`), not the model the client asked for. Clients
 * must only ever see the published model id, so every relayed body swaps the
 * JSON string token of the core id for the published one.
 *
 * Only the complete JSON string token (quotes included) is replaced: inside a
 * JSON string value the quotes are escaped, so generated text that happens to
 * mention the id is never altered.
 */
export class CoreModelIdRewriter {
  private readonly needle: Buffer;
  private readonly replacement: Buffer;
  private carry: Buffer = Buffer.alloc(0);

  private constructor(coreModelId: string, publicModelId: string) {
    this.needle = Buffer.from(JSON.stringify(coreModelId), 'utf8');
    this.replacement = Buffer.from(JSON.stringify(publicModelId), 'utf8');
  }

  /** A rewriter, or null when the client already sees the id the core echoes. */
  static create(coreModelId: string, publicModelId: string): CoreModelIdRewriter | null {
    if (!coreModelId || !publicModelId || coreModelId === publicModelId) return null;
    return new CoreModelIdRewriter(coreModelId, publicModelId);
  }

  /**
   * Rewrite one network chunk. Only a tail that could still become the core id
   * is held back, so complete SSE frames (ending in a blank line) pass at once.
   */
  push(chunk: Uint8Array): Uint8Array {
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const hadCarry = this.carry.length > 0;
    const buffer = hadCarry ? Buffer.concat([this.carry, input]) : input;
    const parts: Buffer[] = [];
    let position = 0;
    let index = buffer.indexOf(this.needle, position);
    while (index !== -1) {
      parts.push(buffer.subarray(position, index), this.replacement);
      position = index + this.needle.length;
      index = buffer.indexOf(this.needle, position);
    }
    const hold = this.partialTail(buffer, position);
    const end = buffer.length - hold;
    this.carry = hold ? Buffer.from(buffer.subarray(end)) : Buffer.alloc(0);
    if (!parts.length && !hold && !hadCarry) return chunk;
    parts.push(buffer.subarray(position, end));
    return Buffer.concat(parts);
  }

  /** Bytes held back at the end of the body; they never completed the core id. */
  flush(): Buffer {
    const rest = this.carry;
    this.carry = Buffer.alloc(0);
    return rest;
  }

  /** Length of the longest suffix after `from` that is a proper prefix of the core id. */
  private partialTail(buffer: Buffer, from: number): number {
    const max = Math.min(this.needle.length - 1, buffer.length - from);
    for (let length = max; length > 0; length -= 1) {
      if (buffer.subarray(buffer.length - length).equals(this.needle.subarray(0, length))) return length;
    }
    return 0;
  }
}

/** Same rewrite for a complete text frame (WebSocket messages arrive whole). */
export function rewriteCoreModelIdText(text: string, coreModelId: string, publicModelId: string): string {
  if (!coreModelId || !publicModelId || coreModelId === publicModelId) return text;
  const needle = JSON.stringify(coreModelId);
  return text.includes(needle) ? text.split(needle).join(JSON.stringify(publicModelId)) : text;
}
