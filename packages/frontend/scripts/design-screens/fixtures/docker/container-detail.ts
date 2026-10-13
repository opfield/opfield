/** `docker inspect` payload and side data for the `web` container on apps-1. */
import type { DockerHealthCheck } from "@/types";
import { containers as catalogContainers } from "../catalog";
import { ago } from "../time";
import { apps1, containerByName, fullId } from "./data";

const web = catalogContainers.find((item) => item.name === "web")!;
const webRow = containerByName(apps1.id, "web")!;

export const webContainerId = fullId(web.id);

export const webInspect = {
  Id: webContainerId,
  Name: "/web",
  Created: ago(6, "d"),
  Path: "/docker-entrypoint.sh",
  Args: ["nginx", "-g", "daemon off;"],
  Image: `sha256:${fullId("0001ab12cd34", 1)}`,
  Platform: "linux",
  RestartCount: 0,
  State: {
    Status: "running",
    Running: true,
    Paused: false,
    Restarting: false,
    OOMKilled: false,
    Dead: false,
    Pid: 48213,
    ExitCode: 0,
    Error: "",
    StartedAt: ago(6, "d"),
    FinishedAt: "0001-01-01T00:00:00Z",
    Health: { Status: "healthy", FailingStreak: 0, Log: [] },
  },
  Config: {
    Hostname: "web",
    User: "nginx",
    Env: [
      "API_URL=http://api:3000",
      "PUBLIC_URL=https://app.example.com",
      "NGINX_VERSION=1.27.2",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ],
    Cmd: ["nginx", "-g", "daemon off;"],
    Entrypoint: ["/docker-entrypoint.sh"],
    Image: web.image,
    WorkingDir: "/usr/share/nginx/html",
    ExposedPorts: { "80/tcp": {} },
    Labels: {
      "org.opencontainers.image.source": "https://git.example.com/northwind/web",
      "org.opencontainers.image.version": "2.8.1",
      "wiolett.gateway.managed": "true",
    },
    Healthcheck: {
      Test: ["CMD", "wget", "-qO-", "http://localhost/healthz"],
      Interval: 15_000_000_000,
      Timeout: 3_000_000_000,
      Retries: 3,
    },
  },
  HostConfig: {
    RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
    PortBindings: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
    Memory: 512 * 1024 ** 2,
    NanoCpus: 1_000_000_000,
    CpuShares: 0,
    PidsLimit: 512,
    NetworkMode: "northwind-internal",
    Binds: [],
    LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
  },
  Mounts: [
    {
      Type: "volume",
      Name: "web-uploads",
      Source: "/var/lib/docker/volumes/web-uploads/_data",
      Destination: "/usr/share/nginx/html/uploads",
      Driver: "local",
      Mode: "z",
      RW: true,
    },
    {
      Type: "bind",
      Source: "/srv/northwind/web/nginx.conf",
      Destination: "/etc/nginx/conf.d/default.conf",
      Mode: "ro",
      RW: false,
    },
  ],
  NetworkSettings: {
    Networks: {
      "northwind-internal": {
        IPAddress: "172.20.0.4",
        Gateway: "172.20.0.1",
        MacAddress: "02:42:ac:14:00:04",
        Aliases: ["web"],
      },
      bridge: {
        IPAddress: "172.17.0.3",
        Gateway: "172.17.0.1",
        MacAddress: "02:42:ac:11:00:03",
      },
    },
    Ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
  },
  // Opfield decorations on top of the raw inspect.
  nodeId: apps1.id,
  availability: "available" as const,
  scopeResourceId: webRow.scopeResourceId,
  folderId: webRow.folderId,
  healthCheckId: webRow.healthCheckId,
  gpuAttachment: { mode: "none" as const, deviceIds: [] },
  _buildRollout: null,
};

export const webHealthCheck: DockerHealthCheck = {
  id: webRow.healthCheckId ?? null,
  target: "container",
  nodeId: apps1.id,
  containerName: "web",
  deploymentId: null,
  enabled: true,
  scheme: "http",
  hostPort: 8080,
  containerPort: 80,
  path: "/healthz",
  statusMin: 200,
  statusMax: 399,
  expectedBody: null,
  bodyMatchMode: "includes",
  intervalSeconds: 30,
  timeoutSeconds: 5,
  slowThreshold: 3,
  healthStatus: "online",
  lastHealthCheckAt: ago(25, "s"),
  // One check every 5 minutes for the last 14 hours; a slow spell mid-morning.
  healthHistory: Array.from({ length: 168 }, (_, index) => ({
    ts: ago((168 - index) * 5, "m"),
    status: index === 101 ? "offline" : "online",
    responseMs: 34 + ((index * 11) % 29) + (index >= 96 && index <= 103 ? 900 : 0),
    slow: index >= 96 && index <= 103,
  })),
  routeOptions: [
    {
      id: "8080-80",
      scheme: "http",
      hostPort: 8080,
      containerPort: 80,
      label: "0.0.0.0:8080 → 80/tcp",
      isPrimary: true,
    },
  ],
};
