/**
 * The `checkout` blue/green deployment on apps-1: green serves 1.14.0, blue keeps
 * 1.13.2 on standby for rollback. Uuid seeds: 7110–7119.
 */
import { HttpResponse, http } from "msw";
import type { DockerDeployment, DockerHealthCheck } from "@/types";
import { wrapped } from "../../handlers";
import { ago, uuid } from "../time";
import { apps1, checkoutDeploymentId, containerByName, fullId } from "./data";

const IMAGE = "registry.example.com/northwind/checkout:1.14.0";
const PREVIOUS_IMAGE = "registry.example.com/northwind/checkout:1.13.2";

export const checkoutGreenId = fullId("c0ffee0ba1b2");
export const checkoutBlueId = fullId("c0ffee0ba1b3");
const checkoutRow = containerByName(apps1.id, "checkout")!;

const desiredConfig = {
  image: IMAGE,
  env: {
    DJANGO_SETTINGS_MODULE: "checkout.settings.production",
    PAYMENTS_PROVIDER: "card-opfield",
    ORDER_API_URL: "http://api:3000",
    LOG_LEVEL: "info",
  },
  restartPolicy: "unless-stopped",
  runtimeProfile: "default" as const,
  entrypoint: ["gunicorn"],
  command: ["checkout.wsgi", "--workers", "2", "--bind", "0.0.0.0:8000"],
  workingDir: "/app",
  user: "app",
  mounts: [],
  labels: { "org.opencontainers.image.source": "https://github.example.net/northwind/checkout" },
  runtime: { memoryLimit: 768 * 1024 ** 2, nanoCpus: 1_000_000_000, pidsLimit: 256 },
};

export const checkoutHealthCheck: DockerHealthCheck = {
  id: checkoutRow.healthCheckId,
  target: "deployment",
  nodeId: apps1.id,
  containerName: null,
  deploymentId: checkoutDeploymentId,
  enabled: true,
  scheme: "http",
  hostPort: 8090,
  containerPort: 8000,
  path: "/health",
  statusMin: 200,
  statusMax: 399,
  expectedBody: null,
  bodyMatchMode: "includes",
  intervalSeconds: 15,
  timeoutSeconds: 5,
  slowThreshold: 3,
  healthStatus: "online",
  lastHealthCheckAt: ago(12, "s"),
  // The switch to green three hours ago shows as one short slow spell.
  healthHistory: Array.from({ length: 168 }, (_, index) => ({
    ts: ago((168 - index) * 5, "m"),
    status: "online",
    responseMs: 21 + ((index * 7) % 17) + (index >= 131 && index <= 133 ? 640 : 0),
    slow: index >= 131 && index <= 133,
  })),
  routeOptions: [
    {
      id: "8090-8000",
      scheme: "http",
      hostPort: 8090,
      containerPort: 8000,
      label: "0.0.0.0:8090 → 8000/tcp",
      isPrimary: true,
    },
  ],
} as DockerHealthCheck;

export const checkoutDeployment: DockerDeployment = {
  id: checkoutDeploymentId,
  scopeResourceId: checkoutRow.scopeResourceId,
  nodeId: apps1.id,
  name: "checkout",
  desiredConfig,
  activeSlot: "green",
  status: "ready",
  routerName: "checkout-router",
  routerImage: "nginx:1.27-alpine",
  networkName: "deployment-checkout",
  healthConfig: {
    path: "/health",
    statusMin: 200,
    statusMax: 399,
    timeoutSeconds: 5,
    intervalSeconds: 15,
    successThreshold: 2,
    startupGraceSeconds: 20,
    deployTimeoutSeconds: 180,
  },
  drainSeconds: 30,
  routes: [
    {
      id: uuid(7110),
      deploymentId: checkoutDeploymentId,
      hostPort: 8090,
      containerPort: 8000,
      isPrimary: true,
    },
    {
      id: uuid(7111),
      deploymentId: checkoutDeploymentId,
      hostPort: 9190,
      containerPort: 9100,
      isPrimary: false,
    },
  ],
  slots: [
    {
      id: uuid(7112),
      deploymentId: checkoutDeploymentId,
      slot: "blue",
      containerId: checkoutBlueId,
      containerName: "checkout-blue",
      image: PREVIOUS_IMAGE,
      desiredConfig: { ...desiredConfig, image: PREVIOUS_IMAGE },
      status: "stopped",
      health: "unknown",
      drainingUntil: null,
      updatedAt: ago(3, "h"),
    },
    {
      id: uuid(7113),
      deploymentId: checkoutDeploymentId,
      slot: "green",
      containerId: checkoutGreenId,
      containerName: "checkout-green",
      image: IMAGE,
      desiredConfig,
      status: "running",
      health: "healthy",
      drainingUntil: null,
      updatedAt: ago(3, "h"),
    },
  ],
  releases: [
    {
      id: uuid(7114),
      deploymentId: checkoutDeploymentId,
      fromSlot: "blue",
      toSlot: "green",
      image: IMAGE,
      triggerSource: "build",
      taskId: uuid(7502),
      status: "succeeded",
      error: null,
      createdAt: ago(3, "h"),
      completedAt: ago(3, "h"),
    },
    {
      id: uuid(7115),
      deploymentId: checkoutDeploymentId,
      fromSlot: "green",
      toSlot: "blue",
      image: PREVIOUS_IMAGE,
      triggerSource: "build",
      taskId: null,
      status: "succeeded",
      error: null,
      createdAt: ago(19, "d"),
      completedAt: ago(19, "d"),
    },
    {
      id: uuid(7116),
      deploymentId: checkoutDeploymentId,
      fromSlot: "blue",
      toSlot: "green",
      image: "registry.example.com/northwind/checkout:1.13.1",
      triggerSource: "manual",
      taskId: null,
      status: "failed",
      error: "green did not pass /health within 180s (HTTP 503)",
      createdAt: ago(20, "d"),
      completedAt: ago(20, "d"),
    },
  ],
  webhook: null,
  healthCheck: checkoutHealthCheck,
  availability: "available",
  createdAt: ago(41, "d"),
  updatedAt: ago(3, "h"),
};

function slotInspect(id: string, name: string, image: string, running: boolean) {
  return {
    Id: id,
    Name: `/${name}`,
    Created: ago(3, "h"),
    Path: "gunicorn",
    Args: desiredConfig.command,
    Image: `sha256:${fullId("0004ab12cd34", 4)}`,
    Platform: "linux",
    RestartCount: 0,
    State: {
      Status: running ? "running" : "exited",
      Running: running,
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      Pid: running ? 51_022 : 0,
      ExitCode: 0,
      Error: "",
      StartedAt: ago(3, "h"),
      FinishedAt: running ? "0001-01-01T00:00:00Z" : ago(3, "h"),
      Health: { Status: running ? "healthy" : "none", FailingStreak: 0, Log: [] },
    },
    Config: {
      Hostname: name,
      User: "app",
      Env: Object.entries(desiredConfig.env).map(([key, value]) => `${key}=${value}`),
      Cmd: desiredConfig.command,
      Entrypoint: desiredConfig.entrypoint,
      Image: image,
      WorkingDir: "/app",
      ExposedPorts: { "8000/tcp": {}, "9100/tcp": {} },
      Labels: desiredConfig.labels,
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Memory: desiredConfig.runtime.memoryLimit,
      NanoCpus: desiredConfig.runtime.nanoCpus,
      PidsLimit: desiredConfig.runtime.pidsLimit,
      NetworkMode: "deployment-checkout",
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
    Mounts: [],
    NetworkSettings: {
      Networks: {
        "deployment-checkout": {
          IPAddress: running ? "172.24.0.3" : "",
          Gateway: "172.24.0.1",
          MacAddress: "02:42:ac:18:00:03",
          Aliases: [name],
        },
      },
      Ports: {},
    },
    nodeId: apps1.id,
    availability: "available" as const,
    gpuAttachment: { mode: "none" as const, deviceIds: [] },
  };
}

export const checkoutGreenInspect = slotInspect(checkoutGreenId, "checkout-green", IMAGE, true);
export const checkoutBlueInspect = slotInspect(
  checkoutBlueId,
  "checkout-blue",
  PREVIOUS_IMAGE,
  false
);

/** Runtime ids of the slots, for the runtime handlers' stats and processes. */
export const checkoutRuntimeNames = {
  [checkoutGreenId]: "checkout",
  [checkoutBlueId]: "checkout",
};

export function dockerDeploymentHandlers() {
  const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });
  const isCheckout = (params: Record<string, unknown>) =>
    params.nodeId === apps1.id && params.deploymentId === checkoutDeploymentId;
  return [
    http.get("*/api/docker/nodes/:nodeId/deployments/by-name/:name", ({ params }) =>
      params.nodeId === apps1.id && params.name === "checkout"
        ? wrapped(checkoutDeployment)
        : notFound()
    ),
    http.get("*/api/docker/nodes/:nodeId/deployments/:deploymentId/health-check", ({ params }) =>
      isCheckout(params) ? wrapped(checkoutHealthCheck) : notFound()
    ),
    http.get("*/api/docker/nodes/:nodeId/deployments/:deploymentId/secrets", ({ params }) =>
      isCheckout(params)
        ? wrapped([
            {
              id: uuid(7117),
              key: "PAYMENTS_API_KEY",
              value: "••••••••",
              createdAt: ago(41, "d"),
              updatedAt: ago(12, "d"),
            },
            {
              id: uuid(7118),
              key: "DATABASE_URL",
              value: "••••••••",
              createdAt: ago(41, "d"),
              updatedAt: ago(41, "d"),
            },
          ])
        : notFound()
    ),
    http.get("*/api/docker/nodes/:nodeId/deployments/:deploymentId/webhook", ({ params }) =>
      isCheckout(params) ? wrapped(null) : notFound()
    ),
    http.get("*/api/docker/nodes/:nodeId/deployments/:deploymentId/image-cleanup", ({ params }) =>
      isCheckout(params)
        ? wrapped({
            id: uuid(7119),
            nodeId: apps1.id,
            targetType: "deployment",
            containerName: null,
            deploymentId: checkoutDeploymentId,
            enabled: true,
            retentionCount: 5,
            createdAt: ago(41, "d"),
            updatedAt: ago(41, "d"),
          })
        : notFound()
    ),
    http.get("*/api/docker/nodes/:nodeId/deployments/:deploymentId", ({ params }) =>
      isCheckout(params) ? wrapped(checkoutDeployment) : notFound()
    ),
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId", ({ params }) => {
      if (params.containerId === checkoutGreenId) return wrapped(checkoutGreenInspect);
      if (params.containerId === checkoutBlueId) return wrapped(checkoutBlueInspect);
      return undefined;
    }),
  ];
}
