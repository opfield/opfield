import { useCallback, useEffect, useRef } from "react";
import { containerUnavailableMessage } from "@/lib/container-stream-unavailable";
import { terminalTheme } from "@/lib/terminal-theme";
import { useUIStore } from "@/stores/ui";
import { encodeTerminalInput } from "./terminal-encoding";
import { TerminalOutputNormalizer } from "./terminal-output";
import { sendTerminalResize } from "./terminal-resize";

interface PopoutTerminalProps {
  /** Factory that creates the WebSocket connection */
  wsFactory: () => WebSocket;
  /** BroadcastChannel key matching the parent tab's channelKey */
  channelKey: string;
  /** Window title */
  title?: string;
}

/**
 * Fullscreen terminal for popout windows. Handles BroadcastChannel
 * announcements (heartbeat, close) to coordinate with the parent tab.
 */
export function PopoutTerminal({ wsFactory, channelKey, title }: PopoutTerminalProps) {
  const resolvedTheme = useUIStore((state) => state.resolvedTheme);
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const connectRef = useRef<(() => void) | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const gotFirstOutput = useRef(false);
  const isReconnect = useRef(false);
  const authFailedRef = useRef(false);

  // BroadcastChannel — announce presence to parent tab
  useEffect(() => {
    const channel = new BroadcastChannel(channelKey);
    channel.postMessage({ type: "popout-open" });

    channel.onmessage = (evt) => {
      if (evt.data?.type === "ping") channel.postMessage({ type: "pong" });
      if (evt.data?.type === "request-close") window.close();
    };

    const heartbeat = setInterval(() => {
      channel.postMessage({ type: "heartbeat" });
    }, 2000);

    const onPageHide = () => channel.postMessage({ type: "popout-close" });
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(heartbeat);
      channel.postMessage({ type: "popout-close" });
      channel.close();
    };
  }, [channelKey]);

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(() => {
      connectRef.current?.();
    }, 3000);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The theme tokens are read from the document; a new callback on a theme switch re-applies them.
  const getTerminalTheme = useCallback(() => {
    const style = getComputedStyle(document.documentElement);
    return terminalTheme(style);
  }, [resolvedTheme]);

  const connect = useCallback(async () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
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
        wsRef.current?.close();
        terminalRef.current = null;
        wsRef.current = null;
      };
    }

    const terminal = terminalRef.current;
    terminal.options.theme = getTerminalTheme();

    if (!isReconnect.current) {
      gotFirstOutput.current = false;
      terminal.write("Connecting...\r\n");
    } else {
      terminal.write("\r\n[reconnecting...]\r\n");
    }

    const ws = wsFactory();
    const outputNormalizer = new TerminalOutputNormalizer();
    wsRef.current = ws;
    authFailedRef.current = false;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      terminal.focus();
      sendTerminalResize(ws, terminal.rows, terminal.cols);
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "connected") {
          if (msg.isNew) {
            const shellName = (msg.shell ?? "/bin/sh").split("/").pop();
            terminal.write(`Using ${shellName}...\r\n`);
            gotFirstOutput.current = true;
          } else {
            terminal.clear();
            gotFirstOutput.current = true;
          }
          sendTerminalResize(ws, terminal.rows, terminal.cols);
        } else if (msg.type === "output") {
          if (!gotFirstOutput.current) {
            gotFirstOutput.current = true;
            terminal.clear();
          }
          const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
          const normalized = outputNormalizer.push(bytes);
          if (normalized.length > 0) terminal.write(normalized);
        } else if (msg.type === "exit") {
          terminal.write(`\r\nProcess exited (code ${msg.exitCode}). Reconnecting...\r\n`);
          isReconnect.current = false;
          scheduleReconnect();
        } else if (msg.type === "auth_error") {
          authFailedRef.current = true;
          terminal.write(`\r\nAccess denied: ${msg.message}\r\n`);
          try {
            ws.close(1008, "Authentication failed");
          } catch {
            /* */
          }
        } else if (msg.type === "error") {
          // A container being recreated is not an error: the reconnect reaches its replacement.
          const unavailable = containerUnavailableMessage(msg);
          terminal.write(`\r\n${unavailable ?? `Error: ${msg.message}`}\r\n`);
        }
      } catch {
        /* */
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      if (authFailedRef.current) return;
      terminal.write("\r\nConnection lost. Reconnecting...\r\n");
      isReconnect.current = true;
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      if (authFailedRef.current) return;
      terminal.write("\r\nConnection error. Reconnecting...\r\n");
      isReconnect.current = true;
      scheduleReconnect();
    };
  }, [scheduleReconnect, wsFactory, getTerminalTheme]);

  connectRef.current = connect;

  const didConnect = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    if (!didConnect.current) {
      didConnect.current = true;
      connect();
    }
    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [connect]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme();
    }
  }, [getTerminalTheme]);

  return (
    <div ref={termRef} className="terminal-console fixed inset-0 bg-card" style={{ padding: 4 }} />
  );
}
