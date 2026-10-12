import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/services/api", () => ({ api: {} }));

import { classifyLogStreamError, LogsTab, type LogsTabSource, logReconnectDelay } from "./LogsTab";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor() {
    FakeSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  /** The server sends an error frame and closes, like docker-compose-logs.ws.ts. */
  fail(message: string) {
    this.onmessage?.({ data: JSON.stringify({ type: "error", message }) });
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

class FakeBroadcastChannel {
  onmessage: unknown = null;
  postMessage() {}
  close() {}
}

function composeSource(): LogsTabSource {
  return {
    channelId: "compose:node-1:shop",
    title: "Compose logs",
    description: "Aggregated output",
    state: "running",
    downloadFileName: "compose-shop-logs.txt",
    createWebSocket: () => new FakeSocket() as unknown as WebSocket,
    getLogs: async () => [],
  };
}

describe("log stream errors", () => {
  it("keeps reconnecting for node-offline and no-container states, stops on access errors", () => {
    expect(classifyLogStreamError("Node not connected")).toBe("retry");
    expect(classifyLogStreamError("No containers found for compose project")).toBe("retry");
    expect(classifyLogStreamError("No such container: abc")).toBe("terminal");
    expect(classifyLogStreamError("Forbidden")).toBe("terminal");
    expect(classifyLogStreamError("anything", "auth_error")).toBe("terminal");
  });

  it("backs off from 3 s up to 30 s", () => {
    expect([0, 1, 2, 3, 4, 10].map(logReconnectDelay)).toEqual([
      3000, 6000, 12000, 24000, 30000, 30000,
    ]);
  });
});

describe("LogsTab while the stream keeps failing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    FakeSocket.instances = [];
    toast.error.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the error inline, never toasts, and reconnects with a growing delay", async () => {
    render(<LogsTab source={composeSource()} />);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(FakeSocket.instances).toHaveLength(1);

    act(() => FakeSocket.instances[0]!.fail("Node not connected"));
    expect(screen.getByText("Node not connected")).toBeTruthy();

    // First retry after 3 s, the next only after 6 s more.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => FakeSocket.instances[1]!.fail("Node not connected"));
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(FakeSocket.instances).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(FakeSocket.instances).toHaveLength(3);
    act(() => FakeSocket.instances[2]!.fail("No containers found for compose project"));

    expect(screen.getByText("No containers found for compose project")).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
