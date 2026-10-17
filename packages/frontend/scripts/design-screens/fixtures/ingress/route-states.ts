/**
 * Route detail states beyond the healthy app route: maintenance with an access
 * code, raw config mode, a failed TLS distribution, and the docs-portal tags
 * the Pages targets resolve. Seeds 22550-22599. Each spec applies a state in
 * `before`; every export file has its own module scope, so the change stays
 * local to that screen.
 */
import { http } from "msw";
import type { PageTag, ProxyHost } from "@/types";
import { wrapped } from "../../handlers";
import { docsProject } from "../data/pages";
import { appRoute, proxyHostBySlug } from "../routes/data";
import { ago, uuid } from "../time";
import { appSecureLinkStatus } from "./route-detail";

export const statusRoute = proxyHostBySlug("status")!;
export const apiRoute = proxyHostBySlug("api")!;

/** app.example.com during a planned database migration. */
export function enterMaintenance(host: ProxyHost = appRoute) {
  host.maintenanceEnabled = true;
  host.maintenanceStartedAt = ago(25, "m");
}

export const statusRawConfig = `# Hand-written server block: template rendering is bypassed.
server {
  listen 443 ssl;
  http2 on;
  server_name status.example.com;

  ssl_certificate     /etc/opfield/tls/status.example.com/fullchain.pem;
  ssl_certificate_key /etc/opfield/tls/status.example.com/privkey.pem;

  # Cache the public status JSON for 15 seconds.
  location = /api/status.json {
    proxy_cache status_cache;
    proxy_cache_valid 200 15s;
    proxy_pass http://192.0.2.40:3001;
  }

  location / {
    proxy_pass http://192.0.2.40:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
`;

/** status.example.com served from a hand-written server block. */
export function enterRawMode(host: ProxyHost = statusRoute) {
  host.rawConfigEnabled = true;
  host.rawConfig = statusRawConfig;
}

/** api.example.com after a renewal its edge replica never confirmed. */
export function failTlsDistribution(host: ProxyHost = apiRoute) {
  host.tlsDistribution = {
    status: "failed",
    replicaCount: 2,
    readyReplicaCount: 1,
    lastVerifiedAt: ago(6, "m"),
    error: "edge-ams-1 did not confirm the renewed certificate within 60 s",
  };
}

const docsTarget = proxyHostBySlug("docs")!.pageTarget!;

function docsTag(id: string, name: string, sequence: number, system = false): PageTag {
  return {
    id,
    projectId: docsProject.id,
    name,
    system,
    generation: system ? 18 : 14,
    deployment: {
      id: sequence === 18 ? docsTarget.deploymentId! : uuid(22560 + sequence),
      sequence,
      publicSlug: `d${sequence}k7m2x9qp`,
      status: "ready",
    },
    createdAt: ago(90, "d"),
    updatedAt: ago(1, "d"),
  };
}

/** Tags of docs-portal, which the docs route and the app route's /help/ path serve. */
export const docsPortalTags: PageTag[] = [
  docsTag(uuid(22551), "latest", 18, true),
  docsTag(docsTarget.tagId!, "production", 18),
  docsTag(uuid(22552), "v4-2", 17),
];

/** Answers the docs-portal tags; other projects fall through to the shared Pages fixtures. */
export function docsPortalTagHandlers() {
  return [
    http.get("*/api/pages/:id/tags", ({ params }) =>
      params.id === docsProject.id ? wrapped(docsPortalTags) : undefined
    ),
  ];
}

/** The Apps 1 daemon stopped reporting two minutes ago; the last sample stays on screen. */
export function staleSecureLinkHandlers() {
  return [
    http.get("*/api/proxy-hosts/:id/secure-link", () =>
      wrapped({ ...appSecureLinkStatus, telemetryStale: true, telemetrySampledAt: ago(2, "m") })
    ),
  ];
}

export function routeStateHandlers() {
  return [
    http.post("*/api/proxy-hosts/:id/maintenance-access-code", () =>
      wrapped({ code: "MNT-7K2Q-94XD", expiresInSeconds: 300 })
    ),
  ];
}
