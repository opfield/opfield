/**
 * Route detail tabs beyond Settings: the Link Runtime telemetry, the rendered
 * Nginx config and the access log stream of app.example.com.
 * Seeds 22000-22199 belong to this file.
 */
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { api } from "@/services/api";
import type { ProxySecureLinkStatus } from "@/types";
import { wrapped } from "../../handlers";
import { appsNode, edgeNode } from "../nodes";
import { appRoute, appSecureLinks } from "../routes/data";
import { ago, agoMs } from "../time";

// ── Link Runtime (Secure Link telemetry) ────────────────────────────────

type Runtime = NonNullable<ProxySecureLinkStatus["runtime"]>;
type Traffic = NonNullable<ProxySecureLinkStatus["traffic"]>;

/** Counters of one sample `step` polls (2s each) before now; totals grow steadily. */
function runtimeAt(step: number, base: number): Runtime {
  const index = 60 - step;
  const wave = Math.round(Math.sin(index / 5) * 4 + Math.cos(index / 3) * 2);
  const opened = base + index * 37 + Math.max(0, wave) * 3;
  return {
    routeId: appRoute.id,
    activeStreams: 18 + wave,
    openedTotal: String(opened),
    completedTotal: String(opened - 18 - wave),
    failedTotal: String(Math.floor(base / 900) + (index > 44 ? 1 : 0)),
    throttledTotal: "0",
    sourceToTargetBytes: String(base * 2_100 + index * 91_000),
    targetToSourceBytes: String(base * 14_300 + index * 612_000 + wave * 20_000),
    setupLatencyP95Ms: 3.4 + (index % 7) * 0.2,
    averageDurationMs: 1_840 + wave * 45,
    lastActivityAt: ago(step * 2, "s"),
    metricsSince: ago(6, "d"),
  };
}

function trafficAt(step: number): Traffic {
  const index = 60 - step;
  const wave = Math.sin(index / 6) * 9;
  return {
    hostId: appRoute.id,
    statusCodes: { s2xx: 41_870 + index * 60, s3xx: 1_204, s4xx: 318, s5xx: 4 },
    // Seconds, as nginx reports request time.
    avgResponseTime: (42 + wave / 3) / 1000,
    p95ResponseTime: (128 + wave) / 1000,
    totalRequests: 43_396 + index * 60,
    totalBytes: 1_902_000_000 + index * 2_600_000,
    requestsPerSecond: 31 + wave,
    bytesPerSecond: 1_310_000 + wave * 40_000,
    busiestClientRps: 6.2,
    windowSeconds: 60,
    sampleTruncated: false,
    lastRequestAt: ago(step * 2, "s"),
  };
}

const HISTORY_STEPS = Array.from({ length: 60 }, (_, index) => 60 - index);

function sampleTime(step: number) {
  return new Date(agoMs(step * 2, "s")).toISOString();
}

const apiLink = appSecureLinks.find((link) => link.name === "route_api")!;
const metricsLink = appSecureLinks.find((link) => link.name === "metrics")!;

export const appSecureLinkStatus: ProxySecureLinkStatus = {
  hasPrimary: true,
  state: "active",
  generation: 7,
  sourceNodeId: edgeNode.id,
  targetNodeId: appsNode.id,
  transport: "quic",
  migratedAt: null,
  lastError: null,
  telemetrySampledAt: ago(2, "s"),
  telemetryStale: false,
  healthCheck: { enabled: true, intervalSeconds: 30 },
  sourceNode: {
    id: edgeNode.id,
    name: edgeNode.displayName ?? edgeNode.hostname,
    status: "online",
  },
  targetNode: {
    id: appsNode.id,
    name: appsNode.displayName ?? appsNode.hostname,
    status: "online",
  },
  rateLimit: {
    mode: "custom",
    enabled: true,
    requestsPerSecond: 200,
    burst: 400,
    connectionsPerIp: 100,
  },
  runtime: runtimeAt(0, 184_000),
  traffic: trafficAt(0),
  history: HISTORY_STEPS.map((step) => ({
    timestamp: sampleTime(step),
    runtime: runtimeAt(step, 184_000),
    traffic: trafficAt(step),
  })),
  additionalLinks: [
    {
      id: apiLink.id,
      name: apiLink.name,
      purpose: "user_managed",
      referenceId: null,
      label: apiLink.name,
      status: "active",
      generation: apiLink.generation,
      targetContainer: apiLink.targetContainer,
      forwardScheme: apiLink.forwardScheme,
      lastError: null,
      runtime: runtimeAt(0, 61_000),
      history: HISTORY_STEPS.map((step) => ({
        timestamp: sampleTime(step),
        runtime: runtimeAt(step, 61_000),
      })),
    },
    {
      id: metricsLink.id,
      name: metricsLink.name,
      purpose: "user_managed",
      referenceId: null,
      label: metricsLink.name,
      status: "provisioning",
      generation: 1,
      targetContainer: metricsLink.targetContainer,
      forwardScheme: metricsLink.forwardScheme,
      lastError: null,
      runtime: null,
      history: [],
    },
  ],
};

// ── Rendered config ─────────────────────────────────────────────────────

export const appRenderedConfig = `# Managed by Opfield — route app.example.com (generation 7)
server {
  listen 443 ssl;
  http2 on;
  server_name app.example.com;

  ssl_certificate     /etc/gateway/tls/app.example.com/fullchain.pem;
  ssl_certificate_key /etc/gateway/tls/app.example.com/privkey.pem;

  limit_req zone=route_app burst=400 nodelay;
  limit_conn route_app_conn 100;

  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;

  location / {
    proxy_pass http://127.0.0.1:42100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }

  location /api/ {
    proxy_pass http://127.0.0.1:42101;
  }
}
`;

export const appAdvancedConfig = `# Extra directives appended to the server block
client_max_body_size 25m;
proxy_read_timeout 120s;

location = /robots.txt {
  add_header Content-Type text/plain;
  return 200 "User-agent: *\\nDisallow: /admin/\\n";
}
`;

// ── Access log stream ───────────────────────────────────────────────────

interface NginxLogEntry {
  hostId: string;
  timestamp: string;
  remoteAddr: string;
  method: string;
  path: string;
  status: number;
  bodyBytesSent: string;
  raw: string;
  logType: string;
  level: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function nginxTime(msAgo: number) {
  const date = new Date(Date.now() - msAgo);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())}/${MONTHS[date.getUTCMonth()]}/${date.getUTCFullYear()}:${pad(
    date.getUTCHours()
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

const ACCESS: Array<[string, string, string, number, number]> = [
  ["198.51.100.23", "GET", "/", 200, 18_342],
  ["198.51.100.23", "GET", "/assets/app-4f9c2a.js", 200, 412_880],
  ["203.0.113.8", "GET", "/api/v1/session", 200, 612],
  ["203.0.113.8", "POST", "/api/v1/orders", 201, 1_204],
  ["192.0.2.144", "GET", "/realtime/socket", 101, 0],
  ["198.51.100.61", "GET", "/pricing", 301, 162],
  ["203.0.113.40", "GET", "/api/v1/orders?page=2", 200, 8_190],
  ["192.0.2.18", "GET", "/favicon.ico", 304, 0],
  ["198.51.100.77", "GET", "/admin/", 404, 548],
  ["203.0.113.8", "PATCH", "/api/v1/profile", 200, 944],
  ["192.0.2.144", "GET", "/help/getting-started", 200, 22_410],
  ["198.51.100.23", "GET", "/api/v1/notifications", 200, 2_318],
  ["203.0.113.91", "POST", "/api/v1/login", 401, 211],
  ["198.51.100.61", "GET", "/", 200, 18_342],
];

export const appAccessLogs: NginxLogEntry[] = [
  ...ACCESS.map(([remoteAddr, method, path, status, bytes], index) => {
    const timestamp = nginxTime((ACCESS.length - index) * 7_000);
    return {
      hostId: appRoute.id,
      timestamp,
      remoteAddr,
      method,
      path,
      status,
      bodyBytesSent: String(bytes),
      raw: `${remoteAddr} - - [${timestamp}] "${method} ${path} HTTP/2.0" ${status} ${bytes} "-" "Mozilla/5.0"`,
      logType: "access",
      level: "",
    };
  }),
  {
    hostId: appRoute.id,
    timestamp: new Date(Date.now() - 3_000).toISOString(),
    remoteAddr: "",
    method: "",
    path: "",
    status: 0,
    bodyBytesSent: "0",
    raw: 'upstream timed out (110: Connection timed out) while reading response header from upstream, request: "GET /api/v1/reports/export"',
    logType: "error",
    level: "error",
  },
];

/**
 * The log tab reads a WebSocket; this stands in for it and answers with the
 * server's first frame (`initial`), like Opfield does on connect.
 */
export function installAccessLogStream(entries = appAccessLogs) {
  vi.spyOn(api, "createProxyLogStreamWebSocket").mockImplementation(() => {
    const socket = {
      readyState: 1,
      onmessage: null as ((event: MessageEvent) => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
      send: () => {},
      close: () => {
        socket.readyState = 3;
      },
    };
    setTimeout(() => {
      socket.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "initial", entries, hasMore: false }),
        })
      );
    }, 0);
    return socket as unknown as WebSocket;
  });
}

/**
 * jsdom has no layout: the log list virtualizes from its scroll box's
 * `offsetHeight` (0), so it renders no rows. Give that one box (the list below
 * the log table header) a desktop height and its rows the list's 52px estimate.
 */
export function giveLogListHeight(height = 640) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const header = this.previousElementSibling;
      if (header?.tagName === "TABLE" || header?.querySelector?.(":scope > table thead")) {
        if (this.closest('[role="tabpanel"]')) return height;
      }
      if (this.hasAttribute("data-index") && this.closest('[role="tabpanel"]')) return 52;
      return original?.get ? original.get.call(this) : 0;
    },
  });
}

/** Everything the route detail tabs read beyond the shared route handlers. */
export function routeDetailHandlers() {
  return [
    http.get("*/api/proxy-hosts/:id/secure-link", ({ params }) =>
      String(params.id) === appRoute.id
        ? wrapped(appSecureLinkStatus)
        : HttpResponse.json({ message: "Not found" }, { status: 404 })
    ),
    http.get("*/api/proxy-hosts/:id/rendered-config", () =>
      wrapped({ rendered: appRenderedConfig })
    ),
  ];
}
