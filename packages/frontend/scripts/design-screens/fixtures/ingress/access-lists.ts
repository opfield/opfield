/**
 * Access lists of the installation: the three the routes reference plus two
 * more, so the list page reads like a real one, with the identity providers and
 * service tokens their rules use. Seeds 22200-22299.
 */
import { http } from "msw";
import type { AccessIdentityProvider, AccessList, AccessServiceToken } from "@/types";
import { ok, wrapped } from "../../handlers";
import { groupIds, groups, users } from "../ops/admin";
import { accessLists as routeAccessLists } from "../routes/data";
import { ago, ahead, uuid } from "../time";

export const accessIdentityProviders: AccessIdentityProvider[] = [
  {
    id: uuid(22211),
    kind: "google",
    name: "Google",
    issuer: "https://accounts.google.com",
    clientId: "4821-k9d2.apps.googleusercontent.com",
    groupsClaim: null,
    trustEmail: true,
    createdAt: ago(80, "d"),
    updatedAt: ago(80, "d"),
  },
  {
    id: uuid(22212),
    kind: "oidc",
    name: "Acme SSO",
    issuer: "https://id.acme.dev",
    clientId: "opfield-access",
    groupsClaim: "groups",
    trustEmail: true,
    createdAt: ago(70, "d"),
    updatedAt: ago(30, "d"),
  },
];

export const accessServiceTokens: AccessServiceToken[] = [
  {
    id: uuid(22221),
    name: "Status checker",
    clientId: "c1f04d7a9e2b4f61.access",
    expiresAt: null,
    createdAt: ago(50, "d"),
    lastUsedAt: ago(1, "h"),
  },
  {
    id: uuid(22222),
    name: "Support CI",
    clientId: "8b3e52c0a7d94e18.access",
    expiresAt: ahead(120, "d"),
    createdAt: ago(20, "d"),
    lastUsedAt: ago(2, "d"),
  },
];

const google = `idp:${uuid(22211)}` as const;

export const accessLists: AccessList[] = [
  ...routeAccessLists,
  {
    id: uuid(22201),
    name: "Support portal",
    description: "Support desk network plus per-agent logins",
    signInMethods: ["opfield", google, "password", "basic"],
    users: [{ username: "lena.novak" }, { username: "sam.patel" }, { username: "omar.haddad" }],
    sharedPasswordSet: false,
    skipIpRanges: ["10.0.40.0/24"],
    includeRules: [
      { selector: "email_domain", values: ["acme.dev"] },
      { selector: "opfield_group", values: [groupIds.onCall] },
      { selector: "service_token", values: [uuid(22222)] },
    ],
    requireRules: [{ selector: "method", values: [google] }],
    excludeRules: [
      { selector: "email", values: ["contractor@acme.dev"] },
      { selector: "ip", values: ["198.51.100.0/24"] },
    ],
    sessionTtlSeconds: 86_400,
    createdAt: ago(64, "d"),
    updatedAt: ago(3, "d"),
    usageCount: 1,
  },
  {
    id: uuid(22202),
    name: "Block scanners",
    description: "Known abusive ranges seen in the access logs",
    signInMethods: [],
    users: [],
    sharedPasswordSet: false,
    skipIpRanges: ["0.0.0.0/0", "::/0"],
    includeRules: [],
    requireRules: [],
    excludeRules: [{ selector: "ip", values: ["198.51.100.200/29", "203.0.113.250"] }],
    sessionTtlSeconds: null,
    createdAt: ago(21, "d"),
    updatedAt: ago(21, "d"),
    usageCount: 4,
  },
];

export const supportPortalAccessList = accessLists.find((list) => list.name === "Support portal")!;

export function accessListHandlers() {
  return [
    http.get("*/api/access-lists", ({ request }) => {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
      return ok({
        data: accessLists,
        pagination: { page: 1, limit, total: accessLists.length, totalPages: 1 },
      });
    }),
    http.get("*/api/access-identity-providers", () => wrapped(accessIdentityProviders)),
    http.get("*/api/access-service-tokens", () => wrapped(accessServiceTokens)),
    http.get("*/api/access-settings", () =>
wrapped({ defaultSessionTtlSeconds: 86_400 })
    ),
    // Opfield user and group rules pick from these.
    http.get("*/api/admin/users", () => ok(users)),
    http.get("*/api/admin/groups", () => ok(groups)),
  ];
}
