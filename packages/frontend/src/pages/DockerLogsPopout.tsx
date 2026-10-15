import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AnsiText } from "@/components/ui/ansi-text";
import { VirtualLogList } from "@/components/ui/virtual-log-list";
import { containerUnavailableMessage } from "@/lib/container-stream-unavailable";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";

const CHANNEL_PREFIX = "docker-logs:";
const MAX_LOG_LINES = 10000;

function capNewestLogs(logs: string[]): string[] {
  return logs.length > MAX_LOG_LINES ? logs.slice(-MAX_LOG_LINES) : logs;
}

function isTerminalLogError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no such container") ||
    lower.includes("not found") ||
    lower.includes("access denied")
  );
}

function hasTimestamp(line: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(line) || /^\d{2}:\d{2}:\d{2}/.test(line);
}

export function DockerLogsPopout() {
  const { nodeId, containerId } = useParams<{ nodeId: string; containerId: string }>();
  const { hasScopedAccess } = useAuthStore();
  const canViewLogs = !!nodeId && !!containerId && hasScopedAccess("docker:containers:view");

  const [lines, setLines] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [historyPrependVersion, setHistoryPrependVersion] = useState(0);
  const [isConnecting, setIsConnecting] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const authFailedRef = useRef(false);
  const terminalErrorRef = useRef(false);

  // BroadcastChannel
  useEffect(() => {
    if (!containerId) return;
    const channel = new BroadcastChannel(CHANNEL_PREFIX + containerId);
    channelRef.current = channel;

    channel.postMessage({ type: "popout-open" });

    channel.onmessage = (evt) => {
      if (evt.data?.type === "ping") channel.postMessage({ type: "pong" });
      if (evt.data?.type === "request-close") window.close();
    };

    const heartbeat = setInterval(() => {
      channel.postMessage({ type: "heartbeat" });
    }, 2000);

    const onPageHide = () => {
      channel.postMessage({ type: "popout-close" });
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(heartbeat);
      channel.postMessage({ type: "popout-close" });
      channel.close();
      channelRef.current = null;
    };
  }, [containerId]);

  useEffect(() => {
    if (containerId) {
      document.title = `Logs — ${containerId.slice(0, 12)}`;
    }
  }, [containerId]);

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

  const connectWs = useCallback(() => {
    if (!canViewLogs || !nodeId || !containerId) return;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnecting(true);
    setLines([]);
    setHistoryPrependVersion(0);
    setHasMore(true);
    setLoadingMore(false);

    const ws = api.createLogStreamWebSocket(nodeId, containerId, 200);
    wsRef.current = ws;
    authFailedRef.current = false;
    terminalErrorRef.current = false;

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "initial") {
          setLines(capNewestLogs(processLogs(msg.lines ?? [])));
          setHasMore(msg.hasMore ?? false);
          setIsConnecting(false);
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
        } else if (msg.type === "logs_ended") {
          ws.close(1012, "Log stream ended");
        } else if (msg.type === "auth_error") {
          authFailedRef.current = true;
          terminalErrorRef.current = true;
          setIsConnecting(false);
          setHasMore(false);
          setLoadingMore(false);
          setLines([`Access denied: ${msg.message}`]);
          try {
            ws.close(1008, "Authentication failed");
          } catch {
            /* */
          }
        } else if (msg.type === "error") {
          const message = msg.message || "Log stream error";
          // Being recreated: shown until the reconnect reaches the replacement container.
          const unavailable = containerUnavailableMessage(msg);
          if (unavailable) setLines([unavailable]);
          terminalErrorRef.current = !unavailable && isTerminalLogError(message);
          setIsConnecting(false);
          if (terminalErrorRef.current) {
            setHasMore(false);
            setLoadingMore(false);
            setLines([message]);
            try {
              ws.close(1011, "Terminal log stream error");
            } catch {
              /* */
            }
          }
        }
      } catch {
        /* */
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      if (!mountedRef.current) return;
      if (authFailedRef.current || terminalErrorRef.current) return;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) connectWs();
      }, 3000);
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setIsConnecting(false);
    };
  }, [canViewLogs, nodeId, containerId, processLogs]);

  useEffect(() => {
    if (!canViewLogs) {
      setIsConnecting(false);
      return;
    }
    mountedRef.current = true;
    const t = setTimeout(() => {
      if (mountedRef.current) connectWs();
    }, 50);
    return () => {
      mountedRef.current = false;
      clearTimeout(t);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [canViewLogs, connectWs]);

  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
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

  if (!canViewLogs) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background px-4 text-sm text-muted-foreground">
        You don't have permission to access container logs.
      </div>
    );
  }

  return (
    <VirtualLogList
      lines={lines}
      keyFn={(_, i) => i}
      prependVersion={historyPrependVersion}
      renderLine={(line) => (
        <div className="whitespace-pre-wrap break-all leading-5 px-4 font-mono text-xs text-foreground/80">
          <AnsiText text={line as string} />
        </div>
      )}
      onLoadMore={requestMoreLines}
      hasMore={hasMore}
      loadingMore={loadingMore}
      className="fixed inset-0 overflow-auto bg-card py-4"
      emptyState={
        <div className="px-4 font-mono text-xs text-muted-foreground">
          {isConnecting ? "Connecting to log stream..." : "No logs available"}
        </div>
      }
    />
  );
}
