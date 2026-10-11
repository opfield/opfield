import { createChildLogger } from '@/lib/logger.js';
import { CLOUD_READ_REQUEST_TYPES, type CloudRequestAudit } from './cloud-link.types.js';

const logger = createChildLogger('CloudLinkAudit');

/** Identical successful reads within this window of the first one share its audit entry. */
export const CLOUD_REQUEST_AUDIT_WINDOW_MS = 10 * 60_000;

type AuditWriter = (agentId: string, audit: CloudRequestAudit) => Promise<void>;

interface RequestWindow {
  agentId: string;
  type: string;
  service: string | undefined;
  startedAt: number;
  /** The request whose own audit entry opened the window. */
  openedBy: string;
  /** Repeats after the first read; the first read has its own entry. */
  repeats: number;
  firstRepeatAt: number | null;
  lastRepeatAt: number | null;
  repeatBytes: number;
  firstRepeatId: string | null;
  lastRepeatId: string | null;
  timer: ReturnType<typeof setTimeout>;
}

/** An open window, for the Settings page's latest requests: the first read's entry plus the repeats not yet written. */
export interface CloudRequestWindowView {
  openedBy: string;
  repeats: number;
  lastAt: string | null;
  repeatBytes: number;
}

/**
 * Coalesces the audit of the portal's repeated reads. The first successful read of a (type, service) writes its
 * entry at once and opens a 10-minute window; identical reads in that window only count. Audit rows are append-only
 * (they also go out to SIEM), so the repeats are written as one summary entry when the window closes, the socket
 * stops, or Gateway shuts down. Failed reads and actions (setup-link, node-token, update) always get their own entry.
 */
export class CloudRequestAuditCoalescer {
  private readonly windows = new Map<string, RequestWindow>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly write: AuditWriter,
    private readonly windowMs = CLOUD_REQUEST_AUDIT_WINDOW_MS,
    private readonly now: () => number = Date.now
  ) {}

  record(agentId: string, audit: CloudRequestAudit): void {
    if (!audit.ok || !CLOUD_READ_REQUEST_TYPES.has(audit.type)) {
      this.track(agentId, audit);
      return;
    }
    const key = JSON.stringify([agentId, audit.type, audit.service ?? null]);
    const open = this.windows.get(key);
    const at = this.now();
    if (open && at - open.startedAt < this.windowMs) {
      open.repeats += 1;
      open.firstRepeatAt ??= at;
      open.lastRepeatAt = at;
      open.repeatBytes += audit.resultBytes;
      open.firstRepeatId ??= audit.requestId;
      open.lastRepeatId = audit.requestId;
      return;
    }
    if (open) this.close(key);
    this.track(agentId, { ...audit, coalescingWindowMs: this.windowMs });
    const timer = setTimeout(() => this.close(key), this.windowMs);
    timer.unref?.();
    this.windows.set(key, {
      agentId,
      type: audit.type,
      service: audit.service,
      startedAt: at,
      openedBy: audit.requestId,
      repeats: 0,
      firstRepeatAt: null,
      lastRepeatAt: null,
      repeatBytes: 0,
      firstRepeatId: null,
      lastRepeatId: null,
      timer,
    });
  }

  /** Writes the summary of every open window and waits for every audit write in flight. */
  async flush(): Promise<void> {
    for (const key of [...this.windows.keys()]) this.close(key);
    await Promise.allSettled([...this.pending]);
  }

  /** Open windows that already counted repeats. */
  live(): CloudRequestWindowView[] {
    return [...this.windows.values()]
      .filter((window) => window.repeats > 0)
      .map((window) => ({
        openedBy: window.openedBy,
        repeats: window.repeats,
        lastAt: window.lastRepeatAt === null ? null : new Date(window.lastRepeatAt).toISOString(),
        repeatBytes: window.repeatBytes,
      }));
  }

  private close(key: string): void {
    const window = this.windows.get(key);
    if (!window) return;
    this.windows.delete(key);
    clearTimeout(window.timer);
    if (window.repeats === 0 || window.firstRepeatAt === null || window.lastRepeatAt === null) return;
    this.track(window.agentId, {
      requestId: window.lastRepeatId ?? window.openedBy,
      type: window.type,
      ...(window.service !== undefined ? { service: window.service } : {}),
      ok: true,
      resultBytes: window.repeatBytes,
      summary: {
        count: window.repeats,
        firstAt: new Date(window.firstRepeatAt).toISOString(),
        lastAt: new Date(window.lastRepeatAt).toISOString(),
        windowStartedAt: new Date(window.startedAt).toISOString(),
        openedBy: window.openedBy,
        firstRequestId: window.firstRepeatId ?? window.openedBy,
        lastRequestId: window.lastRepeatId ?? window.openedBy,
      },
    });
  }

  private track(agentId: string, audit: CloudRequestAudit): void {
    const write = this.write(agentId, audit)
      .catch((error) => {
        logger.warn('Could not write a cloud request audit entry', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.pending.delete(write));
    this.pending.add(write);
  }
}
