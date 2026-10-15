import { ExternalLink, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { containerUnavailableMessage } from "@/lib/container-stream-unavailable";
import { terminalTheme } from "@/lib/terminal-theme";
import { useUIStore } from "@/stores/ui";
import { encodeTerminalInput } from "./terminal-encoding";
import { TerminalOutputNormalizer } from "./terminal-output";
import { sendTerminalResize } from "./terminal-resize";

interface TerminalConsoleProps {
  /** Factory that creates the WebSocket connection */
  wsFactory: () => WebSocket;
  /** BroadcastChannel key for popout tracking (e.g. "docker-console:abc123") */
  channelKey?: string;
  /** URL for popout window (e.g. "/docker/console/nodeId/containerId?shell=auto") */
  popoutUrl?: string;
  /** Label for initial connecting message (e.g. "abc123def456") */
  connectLabel?: string;
  /** The stream found no container (recreated, not running yet): the page looks it up again. */
  onContainerUnavailable?: () => void;
}

export function TerminalConsole({
  wsFactory,
  channelKey,
  popoutUrl,
  connectLabel,
  onContainerUnavailable,
}: TerminalConsoleProps) {
  const resolvedTheme = useUIStore((state) => state.resolvedTheme);
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<any>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const connectRef = useRef<(() => void) | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const gotFirstOutput = useRef(false);
  const isReconnect = useRef(false);
  const authFailedRef = useRef(false);
  const onContainerUnavailableRef = useRef(onContainerUnavailable);
  onContainerUnavailableRef.current = onContainerUnavailable;

  // ── Popout tracking via BroadcastChannel ──
  const [isPopout, setIsPopout] = useState(false);
  const isPopoutRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const popoutAliveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!channelKey) return;
    const channel = new BroadcastChannel(channelKey);
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
  }, [channelKey]);

  const openPopout = useCallback(() => {
    if (!popoutUrl) return;
    window.open(popoutUrl, `console-${channelKey}`, "width=900,height=600,menubar=no,toolbar=no");
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    isPopoutRef.current = true;
    setIsPopout(true);
  }, [popoutUrl, channelKey]);

  const bringBack = useCallback(() => {
    channelRef.current?.postMessage({ type: "request-close" });
    isPopoutRef.current = false;
    setIsPopout(false);
    if (popoutAliveTimer.current) clearTimeout(popoutAliveTimer.current);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      const currentSocket = wsRef.current;
      if (
        currentSocket &&
        (currentSocket.readyState === WebSocket.CONNECTING ||
          currentSocket.readyState === WebSocket.OPEN)
      ) {
        return;
      }
      connectRef.current?.();
    }, 3000);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The theme tokens are read from the document; a new callback on a theme switch re-applies them.
  const getTerminalTheme = useCallback(() => {
    const style = getComputedStyle(document.documentElement);
    return terminalTheme(style);
  }, [resolvedTheme]);

  const connect = useCallback(async () => {
    const previousSocket = wsRef.current;
    if (previousSocket) {
      wsRef.current = null;
      previousSocket.onopen = null;
      previousSocket.onmessage = null;
      previousSocket.onclose = null;
      previousSocket.onerror = null;
      previousSocket.close();
    }

    if (!mountedRef.current) return;

    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);

    if (!document.querySelector("link[data-xterm-css]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.dataset.xtermCss = "true";
      link.href = new URL("@xterm/xterm/css/xterm.css", import.meta.url).href;
      document.head.appendChild(link);
    }

    if (!termRef.current || !mountedRef.current) return;

    if (!terminalRef.current) {
      const terminal = new Terminal({
        cursorBlink: true,
        theme: getTerminalTheme(),
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(termRef.current);
      setTimeout(() => {
        fitAddon.fit();
        terminal.focus();
      }, 50);
      terminalRef.current = terminal;
      fitRef.current = fitAddon;

      const resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
        } catch {
          /* */
        }
      });
      resizeObserver.observe(termRef.current);

      const resizeDisposable = terminal.onResize(
        ({ rows, cols }: { rows: number; cols: number }) => {
          sendTerminalResize(wsRef.current, rows, cols);
        }
      );

      const dataDisposable = terminal.onData((data: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "input", data: encodeTerminalInput(data) }));
        }
      });

      cleanupRef.current = () => {
        resizeObserver.disconnect();
        resizeDisposable.dispose();
        dataDisposable.dispose();
        terminal.dispose();
        const activeSocket = wsRef.current;
        wsRef.current = null;
        if (activeSocket) {
          activeSocket.onopen = null;
          activeSocket.onmessage = null;
          activeSocket.onclose = null;
          activeSocket.onerror = null;
          activeSocket.close();
        }
        terminalRef.current = null;
        fitRef.current = null;
      };
    }

    const terminal = terminalRef.current;
    terminal.options.theme = getTerminalTheme();

    if (!isReconnect.current) {
      gotFirstOutput.current = false;
      terminal.write(`Connecting${connectLabel ? ` to ${connectLabel}` : ""}...\r\n`);
    } else {
      terminal.write(`\r\n[reconnecting...]\r\n`);
    }

    const ws = wsFactory();
    const outputNormalizer = new TerminalOutputNormalizer();
    wsRef.current = ws;
    authFailedRef.current = false;

    ws.onopen = () => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      terminal.focus();
      sendTerminalResize(ws, terminal.rows, terminal.cols);
    };

    let cleared = false;

    ws.onmessage = (evt) => {
      if (wsRef.current !== ws) return;
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "connected") {
          if (!cleared) {
            terminal.clear();
            cleared = true;
          }
          if (msg.isNew) {
            const shellName = (msg.shell ?? "/bin/sh").split("/").pop();
            terminal.write(`Using ${shellName}...\r\n`);
          }
          sendTerminalResize(ws, terminal.rows, terminal.cols);
        } else if (msg.type === "output") {
          if (!cleared) {
            terminal.clear();
            cleared = true;
          }
          const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
          const normalized = outputNormalizer.push(bytes);
          if (normalized.length > 0) terminal.write(normalized);
        } else if (msg.type === "exit") {
          terminal.write(`\r\nProcess exited (code ${msg.exitCode}). Reconnecting...\r\n`);
          isReconnect.current = true;
        } else if (msg.type === "auth_error") {
          authFailedRef.current = true;
          terminal.write(`\r\nAccess denied: ${msg.message}\r\n`);
          try {
            ws.close(1008, "Authentication failed");
          } catch {
            /* */
          }
        } else if (msg.type === "error") {
          // A container being recreated is not an error: say so and reconnect once it runs.
          const unavailable = containerUnavailableMessage(msg);
          if (unavailable) onContainerUnavailableRef.current?.();
          terminal.write(`\r\n${unavailable ?? `Error: ${msg.message}`}\r\n`);
        }
      } catch {
        /* */
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      wsRef.current = null;
      if (authFailedRef.current) return;
      terminal.write(`\r\nConnection lost. Reconnecting...\r\n`);
      isReconnect.current = true;
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      if (authFailedRef.current) return;
      terminal.write(`\r\nConnection error. Waiting for reconnect...\r\n`);
    };
  }, [scheduleReconnect, wsFactory, connectLabel, getTerminalTheme]);

  connectRef.current = connect;

  const didConnect = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    const startTimer = setTimeout(() => {
      if (!didConnect.current && !isPopoutRef.current) {
        didConnect.current = true;
        connect();
      }
    }, 200);

    return () => {
      clearTimeout(startTimer);
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [connect]);

  useEffect(() => {
    if (isPopout && wsRef.current) {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    }
  }, [isPopout]);

  useEffect(() => {
    if (!isPopout && didConnect.current && !wsRef.current && mountedRef.current) {
      isReconnect.current = true;
      connect();
    }
  }, [isPopout, connect]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme();
      fitRef.current?.fit?.();
    }
  }, [getTerminalTheme]);

  if (isPopout) {
    return (
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 bg-card flex flex-col items-center justify-center gap-4">
          <Terminal className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Console is open in a separate window</p>
          <Button variant="outline" onClick={bringBack}>
            Bring back here
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={termRef} className="terminal-console absolute inset-0 bg-card overflow-hidden" />
      {popoutUrl && (
        <div className="absolute right-2.5 bottom-2.5 z-10">
          <Button variant="outline" onClick={openPopout}>
            <ExternalLink className="h-4 w-4" />
            Pop out
          </Button>
        </div>
      )}
    </div>
  );
}
