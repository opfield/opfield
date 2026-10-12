import { Download, ExternalLink, ScrollText } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { AnsiText } from "@/components/ui/ansi-text";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { DockerLogViewport } from "./DockerLogViewport";

const CHANNEL_PREFIX = "docker-logs:";
const MAX_LOG_LINES = 10000;

function capNewestLogs(logs: string[], limit = MAX_LOG_LINES): string[] {
  return logs.length > limit ? logs.slice(-limit) : logs;
}

interface AggregatedLogLine {
  key: string;
  channelId: string;
  source: string;
  text: string;
}

export function mergeReconnectLogLines(
  existing: string[],
  incoming: string[],
  limit = MAX_LOG_LINES
): string[] {
  if (existing.length === 0) return capNewestLogs(incoming, limit);
  if (incoming.length === 0) return existing;

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const existingStart = existing.length - overlap;
    for (let incomingStart = 0; incomingStart + overlap <= incoming.length; incomingStart += 1) {
      let matches = true;
      for (let index = 0; index < overlap; index += 1) {
        if (existing[existingStart + index] !== incoming[incomingStart + index]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return capNewestLogs([...existing, ...incoming.slice(incomingStart + overlap)], limit);
      }
    }
  }

  return capNewestLogs([...existing, ...incoming], limit);
}

function isTerminalLogError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no such container") ||
    lower.includes("not found") ||
    lower.includes("access denied") ||
    /\b(forbidden|unauthori[sz]ed)\b/.test(lower)
  );
}

/**
 * How the Logs tab treats an error frame from the log stream. A stream error is never toasted:
 * it describes the stream's state (node not connected, no containers yet), which the tab shows
 * inline. "terminal" stops reconnecting; "retry" reconnects with a growing delay until the
 * stream delivers logs again.
 */
export function classifyLogStreamError(
  message: string,
  type: "error" | "auth_error" = "error"
): "terminal" | "retry" {
  return type === "auth_error" || isTerminalLogError(message) ? "terminal" : "retry";
}

const LOG_RECONNECT_BASE_MS = 3000;
const LOG_RECONNECT_MAX_MS = 30000;

/** Delay before reconnect attempt `attempt` (0-based): 3 s, doubling up to 30 s. */
export function logReconnectDelay(attempt: number): number {
  return Math.min(LOG_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), LOG_RECONNECT_MAX_MS);
}

function LogStreamNotice({ message }: { message: string }) {
  return (
    <div className="shrink-0 border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
      {message}
    </div>
  );
}

// Detect if a log line already starts with a timestamp
function hasTimestamp(line: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(line) || /^\d{2}:\d{2}:\d{2}/.test(line);
}

export interface LogsTabSource {
  channelId: string;
  runtimeKey?: string;
  title: string;
  description: string;
  state?: string;
  downloadFileName: string;
  createWebSocket: (tail: number) => WebSocket;
  getLogs: (params: { tail?: number; timestamps?: boolean }) => Promise<string[]>;
  popoutUrl?: string;
}

type SingleLogsTabProps =
  | {
      source: LogsTabSource;
      nodeId?: never;
      containerId?: never;
      containerState?: never;
      inspectData?: never;
      headerActions?: ReactNode;
    }
  | {
      source?: never;
      nodeId: string;
      containerId: string;
      containerState?: string;
      inspectData?: Record<string, any>;
      headerActions?: ReactNode;
    };

type LogsTabProps =
  | SingleLogsTabProps
  | {
      sources: LogsTabSource[];
      source?: never;
      nodeId?: never;
      containerId?: never;
      containerState?: never;
      inspectData?: never;
      headerActions?: ReactNode;
    };

export function LogsTab(props: LogsTabProps) {
  if ("sources" in props) {
    return <AggregatedLogsTab sources={props.sources} headerActions={props.headerActions} />;
  }
  return (
    <SingleLogsTab
      key={
        props.source?.runtimeKey ??
        props.source?.channelId ??
        `${props.nodeId}:${props.containerId}`
      }
      {...props}
    />
  );
}

function AggregatedLogsTab({
  sources,
  headerActions,
}: {
  sources: LogsTabSource[];
  headerActions?: ReactNode;
}) {
  const [lines, setLines] = useState<AggregatedLogLine[]>([]);
  const [connecting, setConnecting] = useState(true);
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const sourceIdentity = JSON.stringify(
    sources.map(({ channelId, runtimeKey, state }) => [channelId, runtimeKey, state])
  );

  useEffect(() => {
    // Identity changes deliberately replace all active log subscriptions.
    void sourceIdentity;
    const sources = sourcesRef.current;
    let active = true;
    const disposeSources: Array<() => void> = [];
    let batchId = 0;
    setLines([]);
    setConnecting(true);
    setSourceErrors({});
    let pending = sources.length;
    const ready = () => {
      pending -= 1;
      if (active && pending <= 0) setConnecting(false);
    };
    if (sources.length === 0) {
      setConnecting(false);
      return undefined;
    }
    for (const source of sources) {
      const currentSource = () =>
        sourcesRef.current.find(
          (candidate) =>
            candidate.channelId === source.channelId && candidate.runtimeKey === source.runtimeKey
        ) ?? source;
      let initialized = false;
      const readyOnce = () => {
        if (initialized) return;
        initialized = true;
        ready();
      };
      const setSourceError = (message: string | null) => {
        if (!active) return;
        setSourceErrors((current) => {
          if (message === null) {
            if (!(source.channelId in current)) return current;
            const { [source.channelId]: _cleared, ...rest } = current;
            return rest;
          }
          if (current[source.channelId] === message) return current;
          return { ...current, [source.channelId]: message };
        });
      };
      const append = (incoming: unknown[], reconnectTail = false) => {
        if (!active || incoming.length === 0) return;
        const batch = batchId++;
        const texts = incoming.map(String);
        setLines((current) => {
          if (!active) return current;
          const existing = reconnectTail
            ? current.filter((line) => line.channelId === source.channelId).map((line) => line.text)
            : [];
          // Apply the viewport's global cap after finding the new tail. Capping
          // this source first would hide appended lines when history is full.
          const additions = reconnectTail
            ? mergeReconnectLogLines(existing, texts, Infinity).slice(existing.length)
            : texts;
          const next = [
            ...current,
            ...additions.map((text, index) => ({
              key: `${source.channelId}:${batch}:${index}`,
              channelId: source.channelId,
              source: currentSource().title,
              text,
            })),
          ];
          return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
        });
      };
      if (source.state !== "running") {
        void source
          .getLogs({ tail: 500, timestamps: true })
          .then((result) => append(result ?? []))
          .catch((error) => {
            setSourceError(
              error instanceof Error && error.message ? error.message : "Log stream error"
            );
          })
          .finally(readyOnce);
        continue;
      }
      let socket: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let terminalError = false;
      let reconnectAttempt = 0;
      const scheduleReconnect = () => {
        if (!active || terminalError || reconnectTimer !== null) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, logReconnectDelay(reconnectAttempt++));
      };
      const closeSocket = (ws: WebSocket) => {
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      };
      const finishSocket = (ws: WebSocket) => {
        if (!active || socket !== ws) return;
        socket = null;
        closeSocket(ws);
        readyOnce();
        scheduleReconnect();
      };
      const connect = () => {
        if (!active || terminalError) return;
        let ws: WebSocket;
        try {
          ws = currentSource().createWebSocket(200);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Log stream error";
          terminalError = classifyLogStreamError(message) === "terminal";
          setSourceError(message);
          readyOnce();
          scheduleReconnect();
          return;
        }
        socket = ws;
        ws.onmessage = (event) => {
          if (!active || socket !== ws || terminalError) return;
          try {
            const message = JSON.parse(event.data);
            if (message.type === "initial" || message.type === "new") {
              if (message.type === "initial") {
                reconnectAttempt = 0;
                setSourceError(null);
              }
              append(message.lines ?? [], message.type === "initial");
              readyOnce();
            } else if (message.type === "logs_ended") {
              finishSocket(ws);
            } else if (message.type === "error" || message.type === "auth_error") {
              const detail = message.message || "Log stream error";
              terminalError = classifyLogStreamError(detail, message.type) === "terminal";
              setSourceError(detail);
              finishSocket(ws);
            }
          } catch {
            // Ignore non-JSON stream frames.
          }
        };
        ws.onclose = (event) => {
          if (!active || socket !== ws) return;
          terminalError = event?.code === 1008;
          finishSocket(ws);
        };
        ws.onerror = () => finishSocket(ws);
      };
      connect();
      disposeSources.push(() => {
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        const ws = socket;
        socket = null;
        if (ws) closeSocket(ws);
      });
    }
    return () => {
      active = false;
      for (const dispose of disposeSources) dispose();
    };
  }, [sourceIdentity]);

  const downloadLogs = () => {
    const blob = new Blob([lines.map((line) => `[${line.source}] ${line.text}`).join("\n")], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "availability-all-instances-logs.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const errorLines = sources
    .filter((source) => sourceErrors[source.channelId])
    .map((source) => `${source.title}: ${sourceErrors[source.channelId]}`);

  return (
    <PanelShell
      title="Container Logs"
      description={`stdout and stderr from ${sources.length} serving instances`}
      className="flex min-h-0 flex-1 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      actions={
        <>
          {lines.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              onClick={downloadLogs}
              title="Download"
              aria-label="Download"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          {headerActions}
        </>
      }
    >
      {lines.length > 0 && errorLines.length > 0 && (
        <LogStreamNotice message={errorLines.join(" · ")} />
      )}
      <DockerLogViewport
        lines={lines}
        keyFn={(line) => line.key}
        renderContent={(line) => (
          <>
            <span className="mr-2 text-muted-foreground">[{line.source}]</span>
            <AnsiText text={line.text} />
          </>
        )}
        emptyState={
          <div className="space-y-1 px-4 font-mono text-xs text-muted-foreground">
            {connecting
              ? "Connecting to serving instances..."
              : errorLines.length > 0
                ? errorLines.map((line) => <div key={line}>{line}</div>)
                : "No logs available"}
          </div>
        }
        className="flex-1"
      />
    </PanelShell>
  );
}

function SingleLogsTab(props: SingleLogsTabProps) {
  const source = useMemo<LogsTabSource>(() => {
    if (props.source) return props.source;
    return {
      channelId: `${props.nodeId}:${props.containerId}`,
      title: "Container Logs",
      description:
        props.containerState === "running"
          ? "stdout and stderr output from the container"
          : `Container is ${props.containerState ?? "stopped"} — showing last logs`,
      state: props.containerState,
      downloadFileName: `container-${props.containerId.slice(0, 12)}-logs.txt`,
      createWebSocket: (tail) =>
        api.createLogStreamWebSocket(props.nodeId, props.containerId, tail),
      getLogs: (params) => api.getContainerLogs(props.nodeId, props.containerId, params),
      popoutUrl: `/docker/logs/${props.nodeId}/${props.containerId}`,
    };
  }, [props.containerId, props.containerState, props.nodeId, props.source]);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const inspectData = props.source ? undefined : props.inspectData;
  const [lines, setLines] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [historyPrependVersion, setHistoryPrependVersion] = useState(0);
  const [, setWsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const terminalErrorRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const [streamError, setStreamError] = useState<string | null>(null);

  // ── Popout tracking via BroadcastChannel ──
  const [isPopout, setIsPopout] = useState(false);
  const isPopoutRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const popoutAliveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_PREFIX + source.channelId);
    channelRef.current = channel;

    const markAlive = () => {
      isPopoutRef.current = true;
      setIsPopout(true);
      if (popoutAliveTimer.current) clearTimeout(popoutAliveTimer.current);
      popoutAliveTimer.current = setTimeout(() => {
        isPopoutRef.current = false;
        setIsPopout(false);
      }, 4000);
    };

    channel.onmessage = (evt) => {
      const { type } = evt.data ?? {};
      if (type === "popout-open" || type === "heartbeat" || type === "pong") {
        markAlive();
      }
      if (type === "popout-close") {
        isPopoutRef.current = false;
        setIsPopout(false);
        if (popoutAliveTimer.current) clearTimeout(popoutAliveTimer.current);
      }
    };

    channel.postMessage({ type: "ping" });

    return () => {
      channel.close();
      channelRef.current = null;
      if (popoutAliveTimer.current) clearTimeout(popoutAliveTimer.current);
    };
  }, [source.channelId]);

  const openPopout = useCallback(() => {
    if (!source.popoutUrl) return;
    window.open(
      source.popoutUrl,
      `logs-${source.channelId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      "width=1000,height=600,menubar=no,toolbar=no"
    );

    // Disconnect our WS
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);

    isPopoutRef.current = true;
    setIsPopout(true);
  }, [source.channelId, source.popoutUrl]);

  const bringBack = useCallback(() => {
    channelRef.current?.postMessage({ type: "request-close" });
    isPopoutRef.current = false;
    setIsPopout(false);
    if (popoutAliveTimer.current) clearTimeout(popoutAliveTimer.current);
  }, []);

  const processLine = useCallback((line: string): string => {
    const dockerTsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)$/);
    if (dockerTsMatch) {
      const rest = dockerTsMatch[2];
      if (hasTimestamp(rest)) return rest;
      const ts = new Date(dockerTsMatch[1]);
      const time = ts.toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      return `${time}  ${rest}`;
    }
    return line;
  }, []);

  const processLogs = useCallback(
    (rawLines: string[]): string[] => rawLines.map(processLine),
    [processLine]
  );

  const connectWs = useCallback(
    (resetForSourceChange = false) => {
      // Don't connect if popout is handling logs
      if (isPopoutRef.current) return;

      // Close any existing connection
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      setIsConnecting(true);
      setWsConnected(false);
      if (resetForSourceChange) {
        setLines([]);
        setHistoryPrependVersion(0);
        setHasMore(true);
        setStreamError(null);
        reconnectAttemptRef.current = 0;
      }
      setLoadingMore(false);
      terminalErrorRef.current = false;

      const ws = sourceRef.current.createWebSocket(200);
      wsRef.current = ws;

      ws.onmessage = (evt) => {
        if (!mountedRef.current || wsRef.current !== ws) return;
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "initial") {
            const initialLines = processLogs(msg.lines ?? []);
            setLines((current) =>
              resetForSourceChange
                ? capNewestLogs(initialLines)
                : mergeReconnectLogLines(current, initialLines)
            );
            setHasMore(msg.hasMore ?? false);
            setIsConnecting(false);
            setStreamError(null);
            reconnectAttemptRef.current = 0;
          } else if (msg.type === "history") {
            const historyLines = processLogs(msg.lines ?? []);
            setLines((prev) => {
              const updated = [...historyLines, ...prev];
              return capNewestLogs(updated);
            });
            if (historyLines.length > 0) {
              setHistoryPrependVersion((version) => version + 1);
            }
            setHasMore(msg.hasMore ?? false);
            setLoadingMore(false);
          } else if (msg.type === "new") {
            setLines((prev) => {
              const updated = [...prev, ...processLogs(msg.lines ?? [])];
              return capNewestLogs(updated);
            });
          } else if (msg.type === "connected") {
            setWsConnected(true);
          } else if (msg.type === "logs_ended") {
            // A container restart ends Docker's follow stream while the browser
            // socket can otherwise remain open forever. Closing it activates the
            // normal reconnect path and fetches the new runtime's initial logs.
            ws.close(1012, "Log stream ended");
          } else if (msg.type === "error" || msg.type === "auth_error") {
            const message = msg.message || "Log stream error";
            terminalErrorRef.current = classifyLogStreamError(message, msg.type) === "terminal";
            setStreamError(message);
            setWsConnected(false);
            setIsConnecting(false);
            if (terminalErrorRef.current) {
              setHasMore(false);
            }
          }
        } catch {
          // ignore non-JSON messages
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (!mountedRef.current) return;
        setWsConnected(false);
        if (terminalErrorRef.current) return;
        // Don't auto-reconnect if popout is active — the popout-closes effect handles it
        if (isPopoutRef.current) return;
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(
          () => {
            if (mountedRef.current && !isPopoutRef.current) connectWs();
          },
          logReconnectDelay(reconnectAttemptRef.current++)
        );
      };

      ws.onerror = () => {
        if (!mountedRef.current || wsRef.current !== ws) return;
        setWsConnected(false);
        setIsConnecting(false);
      };
    },
    [processLogs]
  );

  const isRunning = source.state === "running";

  // Fetch static logs for stopped/exited containers
  const fetchStaticLogs = useCallback(async () => {
    const requestedSource = sourceRef.current;
    setIsConnecting(true);
    try {
      const data = await requestedSource.getLogs({ tail: 500, timestamps: true });
      if (!mountedRef.current || sourceRef.current.channelId !== requestedSource.channelId) return;
      setLines(capNewestLogs(processLogs(data ?? [])));
      setHasMore(false);
      setStreamError(null);
    } catch (error) {
      if (mountedRef.current && sourceRef.current.channelId === requestedSource.channelId) {
        setStreamError(
          error instanceof Error && error.message ? error.message : "Log stream error"
        );
      }
    }
    setIsConnecting(false);
  }, [processLogs]);

  // Connect for the current source/runtime. Re-run when a container is
  // recreated or moves between running and stopped states while this tab stays open.
  useEffect(() => {
    const channelId = source.channelId;
    mountedRef.current = true;
    setLines([]);
    setStreamError(null);
    reconnectAttemptRef.current = 0;
    setHistoryPrependVersion(0);
    setHasMore(true);
    setLoadingMore(false);
    isPopoutRef.current = false;
    setIsPopout(false);
    const connectTimeout = setTimeout(() => {
      if (mountedRef.current && !isPopoutRef.current && sourceRef.current.channelId === channelId) {
        if (isRunning) {
          connectWs(true);
        } else {
          fetchStaticLogs();
        }
      }
    }, 200);
    return () => {
      mountedRef.current = false;
      clearTimeout(connectTimeout);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectWs, fetchStaticLogs, isRunning, source.channelId]);

  // If popout opens after we already connected, disconnect
  useEffect(() => {
    if (isPopout && wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    }
  }, [isPopout]);

  // If popout closes, reconnect (wasPopout prevents firing on initial mount)
  const wasPopout = useRef(false);
  useEffect(() => {
    if (isPopout) {
      wasPopout.current = true;
    } else if (wasPopout.current) {
      wasPopout.current = false;
      connectWs(true);
    }
  }, [isPopout, connectWs]);

  // Scroll handler: detect scroll to top for loading more, and track user scroll position
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  // Keep refs in sync with state
  useEffect(() => {
    loadingMoreRef.current = loadingMore;
  }, [loadingMore]);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const requestMoreLines = useCallback(() => {
    if (!hasMoreRef.current || loadingMoreRef.current) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    wsRef.current.send(JSON.stringify({ type: "load_more" }));
  }, []);

  const downloadLogs = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = source.downloadFileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Popout active: show placeholder ──
  if (isPopout) {
    return (
      <PanelShell className="flex flex-1 flex-col min-h-0" bodyClassName="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <ScrollText className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Logs are open in a separate window</p>
          <Button variant="outline" onClick={bringBack}>
            Bring back here
          </Button>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title={source.title}
      description={source.description}
      className="flex flex-1 flex-col min-h-0"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      actions={
        <>
          {lines.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              onClick={downloadLogs}
              title="Download"
              aria-label="Download"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          {source.popoutUrl && (
            <Button
              variant="ghost"
              size="icon"
              onClick={openPopout}
              title="Open in separate window"
              aria-label="Open in separate window"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
          {props.headerActions}
        </>
      }
    >
      {lines.length > 0 && streamError && <LogStreamNotice message={streamError} />}
      <DockerLogViewport
        lines={lines}
        keyFn={(_, i) => i}
        prependVersion={historyPrependVersion}
        renderContent={(line) => <AnsiText text={line as string} />}
        onLoadMore={requestMoreLines}
        hasMore={hasMore}
        loadingMore={loadingMore}
        className="flex-1 min-h-0 overflow-auto bg-card py-4"
        emptyState={
          <div className="px-4 font-mono text-xs text-foreground/80">
            {streamError ? (
              <span className="text-muted-foreground">{streamError}</span>
            ) : isConnecting ? (
              <span className="text-muted-foreground">Connecting to log stream...</span>
            ) : (
              <div className="text-muted-foreground space-y-2">
                <div>No logs available</div>
                {!isRunning && inspectData?.State && (
                  <div className="space-y-1 mt-4 text-xs">
                    <div>
                      Exit Code:{" "}
                      <span
                        className={
                          inspectData.State.ExitCode === 0 ? "text-foreground" : "text-destructive"
                        }
                      >
                        {inspectData.State.ExitCode ?? "unknown"}
                      </span>
                    </div>
                    {inspectData.State.Error && (
                      <div>
                        Error: <span className="text-destructive">{inspectData.State.Error}</span>
                      </div>
                    )}
                    {inspectData.State.OOMKilled && (
                      <div className="text-destructive">
                        Container was killed by OOM (out of memory)
                      </div>
                    )}
                    {inspectData.State.FinishedAt && (
                      <div>
                        Finished: <RelativeTime value={inspectData.State.FinishedAt} />
                      </div>
                    )}
                    {inspectData.Config?.Cmd && (
                      <div>
                        CMD:{" "}
                        <span className="text-foreground/70">
                          {JSON.stringify(inspectData.Config.Cmd)}
                        </span>
                      </div>
                    )}
                    {inspectData.Config?.Entrypoint && (
                      <div>
                        Entrypoint:{" "}
                        <span className="text-foreground/70">
                          {JSON.stringify(inspectData.Config.Entrypoint)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        }
      />
    </PanelShell>
  );
}
