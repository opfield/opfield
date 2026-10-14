/**
 * The core can answer with a model name the client never asked for: the
 * upstream's own name on a native Chat answer, or the provider model id inside
 * a Responses object. Clients only ever see the published model id, so the
 * answer's `model` field (top level, or `response.model` in a Responses event)
 * is set to it. Only that field changes; generated content is never touched.
 */

type Rec = Record<string, unknown>;

/** A non-stream body this large is relayed as received (the core refuses larger native Chat answers). */
export const MAX_HELD_JSON_BODY_BYTES = 32 * 1024 * 1024;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

/** Set `response.model` of a Responses stream event. True when the event changed. */
export function publishResponsesEventModel(event: unknown, publicModelId: string): boolean {
  const response = rec(rec(event)?.response);
  if (!response || typeof response.model !== 'string' || response.model === publicModelId) return false;
  response.model = publicModelId;
  return true;
}

/** One Responses event as JSON text (an SSE data payload or a WebSocket message). */
export function publishResponsesEventText(text: string, publicModelId: string): string {
  // Cheap pre-check: every event that names a model carries the `"model"` key.
  if (!text.includes('"model"')) return text;
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return text;
  }
  return publishResponsesEventModel(event, publicModelId) ? JSON.stringify(event) : text;
}

/**
 * Rewrites complete SSE frames of a Responses stream. Bytes of an unfinished
 * frame are held until its blank-line delimiter arrives, so a frame is only
 * ever relayed whole.
 */
export class ResponsesSseModelRewriter {
  private carry: Buffer = Buffer.alloc(0);

  constructor(private readonly publicModelId: string) {}

  push(chunk: Uint8Array): Uint8Array {
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const buffer = this.carry.length ? Buffer.concat([this.carry, input]) : input;
    const parts: Buffer[] = [];
    let position = 0;
    for (;;) {
      const end = frameEnd(buffer, position);
      if (end === -1) break;
      parts.push(this.rewriteFrame(buffer.subarray(position, end)));
      position = end;
    }
    this.carry = position < buffer.length ? Buffer.from(buffer.subarray(position)) : Buffer.alloc(0);
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  /** An unfinished last frame, relayed as received. */
  flush(): Buffer {
    const rest = this.carry;
    this.carry = Buffer.alloc(0);
    return rest;
  }

  private rewriteFrame(frame: Buffer): Buffer {
    if (frame.indexOf('"model"') === -1) return frame;
    const text = frame.toString('utf8');
    const lines = text.split('\n');
    const dataLines = lines.filter((line) => line.startsWith('data:'));
    // Multi-line data payloads are not produced by the core; relay them untouched.
    if (dataLines.length !== 1) return frame;
    const index = lines.indexOf(dataLines[0]!);
    const line = lines[index]!;
    const carriageReturn = line.endsWith('\r');
    const payload = line.slice(5, carriageReturn ? -1 : undefined).trimStart();
    const rewritten = publishResponsesEventText(payload, this.publicModelId);
    if (rewritten === payload) return frame;
    lines[index] = `data: ${rewritten}${carriageReturn ? '\r' : ''}`;
    return Buffer.from(lines.join('\n'), 'utf8');
  }
}

/** Offset just past the next frame delimiter (a blank line), or -1. */
function frameEnd(buffer: Buffer, from: number): number {
  const lf = buffer.indexOf('\n\n', from);
  const crlf = buffer.indexOf('\r\n\r\n', from);
  if (lf === -1) return crlf === -1 ? -1 : crlf + 4;
  if (crlf === -1 || lf < crlf) return lf + 2;
  return crlf + 4;
}

/**
 * Holds a successful non-stream JSON answer whole, then relays it with its
 * top-level `model` set to the published id. The parsed body is returned so a
 * caller can read other fields (Chat usage).
 */
export class PublishedModelJsonBody {
  private parts: Uint8Array[] = [];
  private size = 0;
  private passthrough = false;

  constructor(private readonly publicModelId: string) {}

  /** Bytes to send now: nothing while held, everything once the body is too large to hold. */
  push(chunk: Uint8Array): Uint8Array | null {
    if (this.passthrough) return chunk;
    this.parts.push(chunk);
    this.size += chunk.byteLength;
    if (this.size <= MAX_HELD_JSON_BODY_BYTES) return null;
    this.passthrough = true;
    return this.take();
  }

  finish(): { body: Uint8Array | null; parsed: Rec | null } {
    if (this.passthrough) return { body: null, parsed: null };
    const raw = this.take();
    let parsed: Rec | null = null;
    try {
      parsed = rec(JSON.parse(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')));
    } catch {
      // Not a JSON object: relay as received.
    }
    if (!parsed || typeof parsed.model !== 'string' || parsed.model === this.publicModelId) {
      return { body: raw, parsed };
    }
    return { body: Buffer.from(JSON.stringify({ ...parsed, model: this.publicModelId }), 'utf8'), parsed };
  }

  private take(): Uint8Array {
    const parts = this.parts;
    this.parts = [];
    this.size = 0;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }
}
