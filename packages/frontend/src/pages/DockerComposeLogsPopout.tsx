import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { terminalTheme } from "@/lib/terminal-theme";
import { useAuthStore } from "@/stores/auth";

const SERVICE_COLORS = [
  "\x1b[36m",
  "\x1b[33m",
  "\x1b[32m",
  "\x1b[35m",
  "\x1b[34m",
  "\x1b[91m",
  "\x1b[92m",
  "\x1b[93m",
] as const;

export function ComposeLogsView({
  nodeId,
  project,
  className = "h-full min-h-80 bg-card",
}: {
  nodeId?: string;
  project?: string;
  className?: string;
}) {
  const { hasScopedAccess } = useAuthStore();
  const canViewLogs = !!nodeId && !!project && hasScopedAccess("docker:compose:view");
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authFailedRef = useRef(false);
  const connectionGenerationRef = useRef(0);

  const [, setContainers] = useState<
    Array<{ id: string; name: string; service: string; state: string }>
  >([]);

  // Color palette for compose services
  const serviceColorMap = useRef(new Map<string, string>());
  const getTerminalTheme = useCallback(() => {
    const style = getComputedStyle(document.documentElement);
    return terminalTheme(style);
  }, []);
  const getServiceColor = useCallback((service: string) => {
    if (!serviceColorMap.current.has(service)) {
      serviceColorMap.current.set(
        service,
        SERVICE_COLORS[serviceColorMap.current.size % SERVICE_COLORS.length]
      );
    }
    return serviceColorMap.current.get(service)!;
  }, []);

  const connect = useCallback(async () => {
    if (!canViewLogs || !nodeId || !project) return;
    const generation = ++connectionGenerationRef.current;
    if (wsRef.current) {
      const previous = wsRef.current;
      wsRef.current = null;
      previous.onclose = null;
      previous.close();
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

    if (!termRef.current || !mountedRef.current || generation !== connectionGenerationRef.current)
      return;

    if (!terminalRef.current) {
      const terminal = new Terminal({
        cursorBlink: false,
        disableStdin: true,
        theme: getTerminalTheme(),
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        convertEol: true,
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(termRef.current);
      setTimeout(() => fitAddon.fit(), 50);
      terminalRef.current = terminal;

      const resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
        } catch {
          /* */
        }
      });
      resizeObserver.observe(termRef.current);

      cleanupRef.current = () => {
        resizeObserver.disconnect();
        terminal.dispose();
        wsRef.current?.close();
        terminalRef.current = null;
        wsRef.current = null;
      };
    }

    const terminal = terminalRef.current;
    terminal.options.theme = getTerminalTheme();
    terminal.write(`\x1b[90mConnecting to compose project "${project}"...\x1b[0m\r\n`);

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/docker/nodes/${nodeId}/compose/${encodeURIComponent(project)}/logs/stream`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    authFailedRef.current = false;

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "connected") {
          setContainers(msg.containers ?? []);
          terminal.write(
            `\x1b[90m${msg.containers?.length ?? 0} containers in project\x1b[0m\r\n\r\n`
          );
        } else if (msg.type === "initial" || msg.type === "new") {
          const lines: string[] = msg.lines ?? [];
          for (const line of lines) {
            // Lines are "service | timestamp content"
            const pipeIdx = line.indexOf(" | ");
            if (pipeIdx > 0) {
              const service = line.slice(0, pipeIdx);
              const rest = line.slice(pipeIdx + 3);
              const color = getServiceColor(service);
              // Pad service name to 20 chars for alignment
              const padded = service.padEnd(15);
              terminal.write(`${color}${padded}\x1b[0m \x1b[90m│\x1b[0m ${rest}\r\n`);
            } else {
              terminal.write(`${line}\r\n`);
            }
          }
        } else if (msg.type === "logs_ended") {
          ws.close(1012, "Compose log stream ended");
        } else if (msg.type === "error") {
          terminal.write(`\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
        } else if (msg.type === "auth_error") {
          authFailedRef.current = true;
          terminal.write(`\x1b[31mAccess denied: ${msg.message}\x1b[0m\r\n`);
          try {
            ws.close(1008, "Authentication failed");
          } catch {
            /* */
          }
        }
      } catch {
        /* */
      }
    };

    ws.onclose = () => {
      if (
        !mountedRef.current ||
        generation !== connectionGenerationRef.current ||
        wsRef.current !== ws
      )
        return;
      wsRef.current = null;
      if (authFailedRef.current) return;
      terminal.write(`\r\n\x1b[90mConnection lost. Reconnecting...\x1b[0m\r\n`);
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, 3000);
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      terminal.write(`\r\n\x1b[31mConnection error.\x1b[0m\r\n`);
    };
  }, [canViewLogs, getServiceColor, nodeId, project, getTerminalTheme]);

  useEffect(() => {
    if (!canViewLogs) return;
    mountedRef.current = true;
    void connect();
    return () => {
      mountedRef.current = false;
      connectionGenerationRef.current += 1;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [canViewLogs, connect]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme();
    }
  }, [getTerminalTheme]);

  if (!canViewLogs) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background px-4 text-sm text-muted-foreground">
        You don't have permission to access Compose logs.
      </div>
    );
  }

  return <div ref={termRef} className={className} style={{ padding: 4 }} />;
}

export function DockerComposeLogsPopout() {
  const { nodeId, project } = useParams<{ nodeId: string; project: string }>();
  useEffect(() => {
    if (project) document.title = `Compose Logs — ${project}`;
  }, [project]);
  return <ComposeLogsView nodeId={nodeId} project={project} className="fixed inset-0 bg-card" />;
}
