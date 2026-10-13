/** An OAuth client asking the signed-in operator for scoped Opfield API access. */
import { HttpResponse, http } from "msw";
import type { OAuthConsentPreview } from "@/types";
import { ok, wrapped } from "../../handlers";
import { databaseHandlers } from "../data/database-handlers";
import { adminUser } from "../identity";
import { dockerSnapshotRows } from "../routes/data";
import { routeHandlers } from "../routes/handlers";
import { ahead } from "../time";

export const OAUTH_REQUEST_ID = "oauth-req-7f3a91c2";

export const oauthConsent: OAuthConsentPreview = {
  requestId: OAUTH_REQUEST_ID,
  client: {
    id: "goc_release_bot",
    name: "Release Bot",
    uri: "https://ci.example.com",
    logoUri: null,
  },
  account: {
    id: adminUser.id,
    email: adminUser.email,
    name: adminUser.name,
    avatarUrl: null,
  },
  requestedScopes: [
    "nodes:details",
    "docker:containers:view",
    "docker:containers:manage",
    "proxy:view",
    "proxy:edit",
    "ssl:cert:view",
  ],
  grantableScopes: [
    "nodes:details",
    "docker:containers:view",
    "docker:containers:manage",
    "proxy:view",
    "proxy:edit",
    "ssl:cert:view",
  ],
  unavailableScopes: [],
  manualApprovalScopes: ["proxy:edit"],
  redirect: { uri: "https://ci.example.com/oauth/callback", isExternal: true },
  resource: "https://gateway.example.com/api",
  resourceInfo: {
    resource: "https://gateway.example.com/api",
    name: "Opfield API",
    description: "REST API access for CLI and external applications.",
  },
  expiresAt: ahead(9, "m"),
};

/** The consent preview plus the resource lists its scope pickers load. */
export function oauthConsentHandlers() {
  return [
    http.get("*/api/oauth/consent/:id", ({ params }) =>
      params.id === OAUTH_REQUEST_ID
        ? ok(oauthConsent)
        : HttpResponse.json({ message: "OAuth request expired" }, { status: 404 })
    ),
    http.get("*/api/logging/schemas", () => ok({ data: [] })),
    http.get("*/api/docker/folders", () => wrapped([])),
    http.get("*/api/ssl-certificates/folders", () => wrapped([])),
    http.get("*/api/docker/nodes/:nodeId/containers", ({ params }) => {
      const data = dockerSnapshotRows.filter((row) => row.nodeId === params.nodeId);
      return ok({ data, total: data.length, limit: 500, truncated: false });
    }),
    ...routeHandlers(),
    ...databaseHandlers(),
  ];
}
