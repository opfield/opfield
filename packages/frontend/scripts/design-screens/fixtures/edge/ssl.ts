import { http } from "msw";
import type { CertificateDistributionState, SSLCertificate } from "@/types";
import { nodeBySlug } from "../nodes";
import { ago, ahead, uuid } from "../time";
import { ok, wrapped } from "../../handlers";
import {
  CLOUDFLARE_CONNECTOR_ID,
  CLOUDFLARE_ZONE_ID,
  cloudflareConnectors,
  paginate,
} from "./domains";

const edgeFra = nodeBySlug("edge-fra-1")!;
const edgeAms = nodeBySlug("edge-ams-1")!;

function deployed(
  targets: Array<typeof edgeFra>,
  status: CertificateDistributionState["status"] = "ready"
): CertificateDistributionState {
  return {
    status,
    replicaCount: targets.length,
    readyReplicaCount: status === "ready" ? targets.length : 0,
    lastVerifiedAt: status === "ready" ? ago(6, "m") : null,
    error: null,
    replicas: targets.map((target) => ({
      nodeId: target.id,
      nodeName: target.displayName ?? target.hostname,
      nodeSlug: target.slug,
      status: status === "not_deployed" ? "pending" : status,
      lastVerifiedAt: status === "ready" ? ago(6, "m") : null,
      error: null,
    })),
  };
}

const notDeployed: CertificateDistributionState = {
  status: "not_deployed",
  replicaCount: 0,
  readyReplicaCount: 0,
  lastVerifiedAt: null,
  error: null,
};

type CertSeed = Partial<SSLCertificate> &
  Pick<SSLCertificate, "id" | "name" | "type" | "domainNames" | "notAfter">;

function cert(seed: CertSeed, issuedDaysAgo: number): SSLCertificate {
  const acme = seed.type === "acme";
  return {
    acmeProvider: acme ? "letsencrypt" : null,
    acmeChallengeType: acme ? "http-01" : null,
    acmePendingOperation: null,
    acmePendingChallenges: null,
    internalCertId: null,
    notBefore: ago(issuedDaysAgo, "d"),
    autoRenew: acme,
    autoRenewProvider: null,
    autoRenewDnsBindings: null,
    autoRenewDisabledReason: null,
    autoRenewDisabledAt: null,
    lastRenewedAt: acme ? ago(issuedDaysAgo, "d") : null,
    renewalError: null,
    status: "active",
    distribution: deployed([edgeFra]),
    isSystem: false,
    folderId: null,
    sortOrder: 0,
    createdAt: ago(issuedDaysAgo + 120, "d"),
    updatedAt: ago(issuedDaysAgo, "d"),
    ...seed,
  };
}

const cloudflareBinding = (domain: string) => ({
  domain,
  connectorId: CLOUDFLARE_CONNECTOR_ID,
  connectorName: cloudflareConnectors[0].name,
  zoneId: CLOUDFLARE_ZONE_ID,
  zoneName: "example.com",
});

/**
 * Ten active certificates plus one expired and one system certificate, matching the
 * dashboard counts (11 total, 10 active, 1 expiring soon: grafana in 9 days).
 */
export const sslCertificates: SSLCertificate[] = [
  cert(
    {
      id: uuid(41201),
      name: "api.example.com",
      type: "acme",
      domainNames: ["api.example.com"],
      notAfter: ahead(90, "d"),
      lastRenewedAt: ago(3, "h"),
      distribution: deployed([edgeFra, edgeAms]),
    },
    0
  ),
  cert(
    {
      id: uuid(41202),
      name: "app.example.com",
      type: "acme",
      domainNames: ["app.example.com"],
      notAfter: ahead(61, "d"),
      distribution: deployed([edgeFra, edgeAms]),
    },
    29
  ),
  cert(
    {
      id: uuid(41203),
      name: "auth.example.com",
      type: "acme",
      domainNames: ["auth.example.com"],
      notAfter: ahead(54, "d"),
      acmeChallengeType: "dns-01",
      autoRenewProvider: "cloudflare",
      autoRenewDnsBindings: [cloudflareBinding("auth.example.com")],
    },
    36
  ),
  cert(
    {
      id: uuid(41204),
      name: "docs.example.org",
      type: "acme",
      domainNames: ["docs.example.org", "www.docs.example.org"],
      notAfter: ahead(77, "d"),
      distribution: deployed([edgeAms]),
    },
    13
  ),
  cert(
    {
      // Same id as the dashboard's "expiring soon" entry.
      id: uuid(8001),
      name: "grafana.example.com",
      type: "acme",
      domainNames: ["grafana.example.com"],
      notAfter: ahead(9, "d"),
      renewalError:
        "HTTP-01 challenge failed: http://grafana.example.com/.well-known/acme-challenge returned 502",
    },
    81
  ),
  cert(
    {
      id: uuid(41205),
      name: "Internal services wildcard",
      type: "internal",
      domainNames: ["*.svc.internal.example.com", "svc.internal.example.com"],
      notAfter: ahead(318, "d"),
      internalCertId: uuid(41290),
      autoRenew: true,
      distribution: deployed([edgeFra, edgeAms]),
    },
    47
  ),
  cert(
    {
      id: uuid(41206),
      name: "shop.example.net",
      type: "upload",
      domainNames: ["shop.example.net", "www.shop.example.net"],
      notAfter: ahead(212, "d"),
      distribution: deployed([edgeAms]),
    },
    153
  ),
  cert(
    {
      id: uuid(41207),
      name: "status.example.com",
      type: "acme",
      domainNames: ["status.example.com"],
      notAfter: ahead(40, "d"),
      acmeChallengeType: "dns-01",
      autoRenewProvider: "cloudflare",
      autoRenewDnsBindings: [cloudflareBinding("status.example.com")],
      distribution: deployed([edgeAms]),
    },
    50
  ),
  cert(
    {
      id: uuid(41208),
      name: "Wildcard example.com",
      type: "acme",
      domainNames: ["*.example.com", "example.com"],
      notAfter: ahead(83, "d"),
      acmeChallengeType: "dns-01",
      autoRenewProvider: "cloudflare",
      autoRenewDnsBindings: [
        cloudflareBinding("*.example.com"),
        cloudflareBinding("example.com"),
      ],
      distribution: deployed([edgeFra, edgeAms], "pending"),
    },
    7
  ),
  cert(
    {
      id: uuid(41209),
      name: "Partner mTLS client",
      type: "internal",
      domainNames: ["partner-gw.example.net"],
      notAfter: ahead(145, "d"),
      internalCertId: uuid(41291),
      autoRenew: false,
      distribution: notDeployed,
    },
    220
  ),
  cert(
    {
      id: uuid(41210),
      name: "old-shop.example.net",
      type: "upload",
      domainNames: ["old-shop.example.net"],
      notAfter: ago(18, "d"),
      status: "expired",
      distribution: notDeployed,
    },
    383
  ),
  cert(
    {
      id: uuid(41211),
      name: "opfield.example.com",
      type: "acme",
      domainNames: ["opfield.example.com"],
      notAfter: ahead(68, "d"),
      isSystem: true,
    },
    22
  ),
];

/** Answers the certificate list the way the server does: filters, system toggle, paging. */
export function sslHandlers() {
  return [
    http.get("*/api/ssl-certificates/folders", () => wrapped([])),
    http.get("*/api/ssl-certificates", ({ request }) => {
      const url = new URL(request.url);
      const search = url.searchParams.get("search")?.toLowerCase();
      const type = url.searchParams.get("type");
      const status = url.searchParams.get("status");
      const showSystem = url.searchParams.get("showSystem") === "true";
      const items = sslCertificates.filter(
        (item) =>
          (showSystem || !item.isSystem) &&
          (!type || item.type === type) &&
          (!status || item.status === status) &&
          (!search ||
            item.name.toLowerCase().includes(search) ||
            item.domainNames.some((name) => name.includes(search)))
      );
      return ok(paginate(items, url));
    }),
    http.get("*/api/ssl-certificates/:id", ({ params }) => {
      const found = sslCertificates.find((item) => item.id === params.id);
      return found ? wrapped(found) : ok({});
    }),
  ];
}
