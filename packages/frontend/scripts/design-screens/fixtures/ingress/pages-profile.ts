/**
 * The Pages domain profile shared by the Pages screens and Settings · Features. A leaf module:
 * it imports only catalog data, so the settings fixtures can use it without an import cycle.
 */
import type { PageProfile, PageProfileOptions } from "@/types";
import { people } from "../catalog";
import { edgeNode } from "../nodes";
import { ago, ahead, uuid } from "../time";

export const PAGES_DOMAIN = "pages.example.com";

const OPFIELD_ISOLATION = {
  gatewayHost: "opfield.example.com",
  gatewayRegistrableDomain: "example.com",
};

/** pages.example.com shares example.com with the console; pages.example.net does not. */
export const pagesProfileOptions: PageProfileOptions = {
  domains: [
    {
      id: uuid(22751),
      domain: PAGES_DOMAIN,
      dnsStatus: "valid",
      nginxNodeId: edgeNode.id,
      isolation: {
        ...OPFIELD_ISOLATION,
        pagesHost: PAGES_DOMAIN,
        pagesRegistrableDomain: "example.com",
        same: true,
      },
    },
    {
      id: uuid(22752),
      domain: "pages.example.net",
      dnsStatus: "valid",
      nginxNodeId: edgeNode.id,
      isolation: {
        ...OPFIELD_ISOLATION,
        pagesHost: "pages.example.net",
        pagesRegistrableDomain: "example.net",
        same: false,
      },
    },
  ],
  nodes: [
    {
      id: edgeNode.id,
      displayName: edgeNode.displayName,
      hostname: edgeNode.hostname,
      status: "online",
      pagesCapable: true,
    },
  ],
  certificates: [
    {
      id: uuid(22753),
      name: "Wildcard pages.example.com",
      domainNames: [`*.${PAGES_DOMAIN}`, PAGES_DOMAIN],
      status: "active",
      notAfter: ahead(64, "d"),
    },
    {
      id: uuid(22754),
      name: "Wildcard pages.example.net",
      domainNames: ["*.pages.example.net"],
      status: "active",
      notAfter: ahead(71, "d"),
    },
  ],
};

const [sharedDomain] = pagesProfileOptions.domains;
const [sharedCertificate] = pagesProfileOptions.certificates;

/** The installation's profile: every preview under pages.example.com, the shared parent acknowledged. */
export const pagesProfileConfigured: PageProfile = {
  id: uuid(22755),
  enabled: true,
  status: "ready",
  domainId: sharedDomain.id,
  nodeId: edgeNode.id,
  certificateId: sharedCertificate.id,
  labelTemplate: "{hash}",
  overrideSameRegistrableDomain: true,
  overrideAcknowledgedById: people[0].id,
  overrideAcknowledgedAt: ago(140, "d"),
  createdAt: ago(140, "d"),
  updatedAt: ago(140, "d"),
  lastErrorCode: null,
  lastErrorMessage: null,
  domain: {
    id: sharedDomain.id,
    domain: sharedDomain.domain,
    dnsStatus: "valid",
    nginxNodeId: edgeNode.id,
  },
  node: {
    id: edgeNode.id,
    displayName: edgeNode.displayName,
    hostname: edgeNode.hostname,
    status: "online",
    pagesCapable: true,
  },
  certificate: {
    id: sharedCertificate.id,
    name: sharedCertificate.name,
    domainNames: sharedCertificate.domainNames,
    status: "active",
    notAfter: sharedCertificate.notAfter,
  },
  isolation: {
    ...OPFIELD_ISOLATION,
    pagesHost: PAGES_DOMAIN,
    pagesRegistrableDomain: "example.com",
    same: true,
    overrideRequired: true,
    overrideCurrent: true,
  },
};
