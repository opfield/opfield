import type { InferenceCoreUsage } from './inference-core.contract.js';
import { chatCompletionUsage } from './inference-core-chat-usage.js';

// Match the managed core's client-facing SSE frame bound. Never discard a
// fragment: a terminal may carry a large reasoning/compaction snapshot.
export const MAX_CORE_SSE_FRAME_BYTES = 4 * 1024 * 1024;

type TerminalOutcome = 'completed' | 'failed';

/** The client-facing wire of a relayed stream; each ends a stream its own way. */
export type CoreSseWire = 'responses' | 'chat_completions' | 'messages';

/** Observe complete frames without changing the bytes relayed to the client. */
export class CoreResponsesSseObserver {
  constructor(private readonly wire: CoreSseWire = 'responses') {}

  /** The last `usage` a Chat Completions stream reported (the core asks upstreams for it). */
  chatUsage: InferenceCoreUsage | null = null;

  private buffer = new Uint8Array(0);
  private length = 0;
  private lineStart = 0;
  private previousLineEnd = 0;

  get hasPendingFrame(): boolean {
    return this.length !== 0;
  }

  clear(): void {
    this.buffer = new Uint8Array(0);
    this.resetFrame();
  }

  observe(chunk: Uint8Array): TerminalOutcome | null {
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf(10, offset);
      if (newline === -1) {
        this.append(chunk.subarray(offset));
        return null;
      }
      this.append(chunk.subarray(offset, newline + 1));
      offset = newline + 1;
      let lineEnd = this.length - 1;
      if (lineEnd > this.lineStart && this.buffer[lineEnd - 1] === 13) lineEnd -= 1;
      if (lineEnd === this.lineStart) {
        // previousLineEnd excludes both line endings of the blank-line delimiter.
        if (this.previousLineEnd > MAX_CORE_SSE_FRAME_BYTES) this.tooLarge();
        const terminal = this.terminalOutcome();
        this.resetFrame();
        // A later event in the same network chunk cannot overwrite a terminal.
        if (terminal) return terminal;
      } else {
        if (lineEnd > MAX_CORE_SSE_FRAME_BYTES) this.tooLarge();
        this.previousLineEnd = lineEnd;
        this.lineStart = this.length;
      }
    }
  }

  private append(bytes: Uint8Array): void {
    const required = this.length + bytes.byteLength;
    // Keep up to four delimiter bytes beyond the frame bound (CRLF CRLF).
    if (required > MAX_CORE_SSE_FRAME_BYTES + 4) this.tooLarge();
    if (required > this.buffer.byteLength) {
      const capacity = Math.min(MAX_CORE_SSE_FRAME_BYTES + 4, Math.max(required, this.buffer.byteLength * 2, 1024));
      const next = new Uint8Array(capacity);
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
    this.buffer.set(bytes, this.length);
    this.length = required;
  }

  private terminalOutcome(): TerminalOutcome | null {
    const block = new TextDecoder().decode(this.buffer.subarray(0, this.previousLineEnd));
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!payload) return null;
    // Chat Completions ends a finished stream with `[DONE]`; the other wires never send it.
    if (payload === '[DONE]') return this.wire === 'chat_completions' ? 'completed' : null;
    try {
      const event = JSON.parse(payload) as { type?: unknown; error?: unknown; choices?: unknown; usage?: unknown };
      if (this.wire === 'chat_completions') {
        this.chatUsage = chatCompletionUsage(event.usage) ?? this.chatUsage;
        // The core reports a failed Chat stream as an error frame and closes without `[DONE]`.
        return event.error && typeof event.error === 'object' && event.choices === undefined ? 'failed' : null;
      }
      if (this.wire === 'messages') {
        if (event.type === 'message_stop') return 'completed';
        return event.type === 'error' ? 'failed' : null;
      }
      if (event.type === 'response.completed') return 'completed';
      if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
        return 'failed';
      }
    } catch {
      // Protocol validation belongs to the core; malformed data is not success.
    }
    return null;
  }

  private resetFrame(): void {
    this.length = 0;
    this.lineStart = 0;
    this.previousLineEnd = 0;
  }

  private tooLarge(): never {
    throw new Error(`Inference core SSE frame exceeded the ${MAX_CORE_SSE_FRAME_BYTES}-byte limit`);
  }
}
