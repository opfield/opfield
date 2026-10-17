/**
 * What the node detail tabs read: the Frankfurt Ingress node's nginx config,
 * files, access log and daemon log, the database host's managed instances and
 * a Build worker node. Uuid seeds: 1570–1599.
 */
import { HttpResponse, http } from "msw";
import type { FileEntry, Node } from "@/types";
import { ok, wrapped } from "../../handlers";
import { dir, file } from "../docker/runtime";
import { installFixtureWebSocket } from "../docker/streams";
import { nodeBySlug, nodeDetail, nodes } from "../nodes";
import { ago } from "../time";
import { buildWorker } from "./builder";

const edge = nodeBySlug("edge-fra-1")!;

/** Every node of the installation, the Build worker included. */
export const allNodes: Node[] = [...nodes, buildWorker];

export const edgeNginxMainConf = `# Managed by Opfield. Route files live in sites/ and are rendered per route.
user www-data;
worker_processes auto;
worker_rlimit_nofile 65535;
pid /run/nginx.pid;

events {
    worker_connections 4096;
    multi_accept on;
}

http {
    sendfile on;
    tcp_nopush on;
    server_tokens off;
    client_max_body_size 64m;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:20m;

    log_format opfield '$remote_addr - $host [$time_local] "$request" $status '
                       '$body_bytes_sent $request_time';
    access_log /var/log/nginx/access.log opfield;

    include /var/lib/opfield/nginx/sites/*.conf;
}
`;

export const edgeFiles: Record<string, FileEntry[]> = {
  "/": [
    dir("bin", 210, "lrwxrwxrwx"),
    dir("boot", 40),
    dir("etc", 1),
    dir("home", 210),
    dir("opt", 30),
    dir("root", 30, "drwx------"),
    dir("run", 0),
    dir("srv", 210),
    dir("tmp", 0, "drwxrwxrwt"),
    dir("usr", 40),
    dir("var", 1),
  ],
  "/etc/nginx": [
    dir("conf.d", 30),
    dir("modules-enabled", 30),
    file("mime.types", 5_349, 90),
    file("nginx.conf", 1_164, 12),
  ],
};

interface AccessSeed {
  secondsAgo: number;
  addr: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  host: string;
}

const access = (seed: AccessSeed) => ({
  hostId: seed.host,
  timestamp: ago(seed.secondsAgo, "s"),
  remoteAddr: seed.addr,
  method: seed.method,
  path: seed.path,
  status: seed.status,
  bodyBytesSent: String(seed.bytes),
  raw: `${seed.addr} - ${seed.host} "${seed.method} ${seed.path} HTTP/2.0" ${seed.status} ${seed.bytes}`,
  logType: "access",
  level: "",
});

export const edgeAccessLog = [
  access({
    secondsAgo: 2,
    addr: "198.51.100.23",
    method: "GET",
    path: "/",
    status: 200,
    bytes: 5_123,
    host: "app.example.com",
  }),
  access({
    secondsAgo: 3,
    addr: "198.51.100.23",
    method: "GET",
    path: "/assets/app-4f1c2a.js",
    status: 200,
    bytes: 184_211,
    host: "app.example.com",
  }),
  access({
    secondsAgo: 5,
    addr: "192.0.2.144",
    method: "POST",
    path: "/v1/orders",
    status: 201,
    bytes: 812,
    host: "api.example.com",
  }),
  access({
    secondsAgo: 8,
    addr: "192.0.2.61",
    method: "GET",
    path: "/login",
    status: 200,
    bytes: 3_310,
    host: "auth.example.com",
  }),
  access({
    secondsAgo: 9,
    addr: "192.0.2.61",
    method: "POST",
    path: "/session",
    status: 302,
    bytes: 0,
    host: "auth.example.com",
  }),
  access({
    secondsAgo: 14,
    addr: "203.0.113.90",
    method: "GET",
    path: "/d/nodes-overview",
    status: 200,
    bytes: 48_220,
    host: "grafana.example.com",
  }),
  access({
    secondsAgo: 17,
    addr: "198.51.100.7",
    method: "GET",
    path: "/wp-login.php",
    status: 404,
    bytes: 153,
    host: "app.example.com",
  }),
  access({
    secondsAgo: 21,
    addr: "192.0.2.144",
    method: "GET",
    path: "/v1/orders?page=2",
    status: 200,
    bytes: 9_402,
    host: "api.example.com",
  }),
  {
    hostId: "legacy-admin.example.com",
    timestamp: ago(26, "s"),
    remoteAddr: "",
    method: "",
    path: "",
    status: 0,
    bodyBytesSent: "",
    raw: 'connect() failed (111: Connection refused) while connecting to upstream, upstream: "https://10.20.0.45:8443/"',
    logType: "error",
    level: "error",
  },
  access({
    secondsAgo: 26,
    addr: "192.0.2.30",
    method: "GET",
    path: "/",
    status: 502,
    bytes: 559,
    host: "legacy-admin.example.com",
  }),
  access({
    secondsAgo: 33,
    addr: "198.51.100.23",
    method: "GET",
    path: "/api/notifications",
    status: 200,
    bytes: 911,
    host: "app.example.com",
  }),
  access({
    secondsAgo: 41,
    addr: "192.0.2.144",
    method: "PATCH",
    path: "/v1/orders/10842",
    status: 200,
    bytes: 604,
    host: "api.example.com",
  }),
  access({
    secondsAgo: 48,
    addr: "203.0.113.90",
    method: "GET",
    path: "/api/ds/query",
    status: 200,
    bytes: 22_904,
    host: "grafana.example.com",
  }),
  access({
    secondsAgo: 55,
    addr: "192.0.2.12",
    method: "GET",
    path: "/healthz",
    status: 200,
    bytes: 2,
    host: "app.example.com",
  }),
];

const daemonLog = (
  secondsAgo: number,
  level: string,
  component: string,
  message: string,
  fields?: Record<string, string>
) => ({
  // The daemon reports RFC 3339 seconds.
  timestamp: ago(secondsAgo, "s").replace(/\.\d{3}Z$/, "Z"),
  level,
  component,
  message,
  fields,
});

export const edgeDaemonLog = [
  daemonLog(3_540, "info", "daemon", "connected to opfield", { relay: "relay-1", latency: "11ms" }),
  daemonLog(3_538, "info", "config", "applied configuration", { version: "c41f9a0", routes: "9" }),
  daemonLog(2_410, "info", "certs", "certificate renewed", { domain: "grafana.example.com" }),
  daemonLog(2_409, "info", "nginx", "reloaded", { workers: "4", took: "38ms" }),
  daemonLog(1_804, "warn", "health", "upstream slow", {
    route: "grafana.example.com",
    p95: "812ms",
  }),
  daemonLog(1_200, "info", "stats", "traffic report sent", { requests: "18412" }),
  daemonLog(612, "error", "health", "upstream unreachable", {
    route: "legacy-admin.example.com",
    error: "connection refused",
  }),
  daemonLog(600, "info", "stats", "traffic report sent", { requests: "17208" }),
  daemonLog(301, "info", "config", "configuration unchanged", { version: "c41f9a0" }),
  daemonLog(42, "info", "daemon", "heartbeat", { uptime: "40d 0h" }),
];

/**
 * The daemon log is a server-sent stream: "connected" with the history count,
 * then one "log" event per buffered line. Other streams (monitoring) stay quiet.
 */
export function installNodeStreams() {
  class NodeEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 1;
    withCredentials = true;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    readonly url: string;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      if (!/\/api\/nodes\/[^/]+\/logs/.test(this.url)) return;
      setTimeout(() => {
        if (this.readyState === 2) return;
        const events: Array<[string, unknown]> = [
          ["connected", { historyCount: edgeDaemonLog.length }],
          ...edgeDaemonLog.map((entry) => ["log", entry] as [string, unknown]),
        ];
        for (const [type, data] of events) {
          this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
        }
      }, 0);
    }

    close() {
      this.readyState = 2;
    }
  }
  Object.defineProperty(window, "EventSource", {
    configurable: true,
    writable: true,
    value: NodeEventSource,
  });

  installFixtureWebSocket((url) =>
    url.includes("/nginx-logs/ws")
      ? [{ type: "initial", entries: [...edgeAccessLog].reverse(), hasMore: false }]
      : []
  );
}

/** Node tab endpoints, and the node list with the Build worker. Pass before the shared ones. */
export function nodeTabHandlers() {
  const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });
  return [
    http.get("*/api/nodes", ({ request }) => {
      const type = new URL(request.url).searchParams.get("type");
      const data = allNodes.filter((node) => !type || type === "all" || node.type === type);
      return ok({ data, total: data.length, page: 1, limit: 50, totalPages: 1 });
    }),
    http.get("*/api/nodes/by-slug/build-1", () => wrapped(nodeDetail(buildWorker))),
    http.get("*/api/nodes/:id/health-history", ({ params }) =>
      params.id === buildWorker.id ? wrapped(buildWorker.healthHistory ?? []) : undefined
    ),
    http.get("*/api/nodes/:id/config", ({ params }) =>
      params.id === edge.id ? wrapped({ content: edgeNginxMainConf }) : notFound()
    ),
    http.get("*/api/nodes/:id/files", ({ params, request }) => {
      if (params.id !== edge.id) return notFound();
      const path = new URL(request.url).searchParams.get("path") ?? "/";
      return wrapped(edgeFiles[path] ?? edgeFiles["/"]);
    }),
    http.get("*/api/nodes/:id", ({ params }) =>
      params.id === buildWorker.id ? wrapped(nodeDetail(buildWorker)) : undefined
    ),
  ];
}
