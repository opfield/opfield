/**
 * Internal PKI of the installation: the certificate authorities, the
 * certificates they issued, the folders both lists are organized in and the
 * PKI certificate templates.
 * The first two CAs are the ones the dashboard and pickers already show.
 * Seeds 23000-23899 belong to this file (23900-23999 to creation.ts).
 */
import { HttpResponse, http } from "msw";
import { useAuthStore } from "@/stores/auth";
import type { CA, Certificate, ResourceFolderTreeNode, Template } from "@/types";
import { ok, wrapped } from "../../handlers";
import { people } from "../catalog";
import { certificateAuthorities } from "../dashboard";
import { expandFolders } from "../data/folders";
import { ago, ahead, uuid } from "../time";

const PEM_PLACEHOLDER = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBfixtureCERTIFICATEplaceholderNOTaREALcertificateFORdesignONLY",
  "AAAAexampleEXAMPLEexampleEXAMPLEexampleEXAMPLEexampleEXAMPLEexampl",
  "-----END CERTIFICATE-----",
].join("\n");

const [rootCa, servicesCa] = certificateAuthorities;

// ── Folders ──────────────────────────────────────────────────────────────

function folder(seed: number, name: string, sortOrder: number): ResourceFolderTreeNode {
  return {
    id: uuid(23300 + seed),
    name,
    parentId: null,
    sortOrder,
    depth: 0,
    createdAt: ago(180, "d"),
    updatedAt: ago(180, "d"),
    children: [],
  };
}

/** CA folders hold whole hierarchies; an intermediate reports its root's folder. */
export const caFolders: ResourceFolderTreeNode[] = [
  folder(1, "Production", 0),
  folder(2, "Partners", 1),
];
const [productionFolder, partnersFolder] = caFolders;

export const certificateFolders: ResourceFolderTreeNode[] = [
  folder(11, "Service mesh", 0),
  folder(12, "Staff devices", 1),
];
const [meshFolder, staffFolder] = certificateFolders;

export const templateFolders: ResourceFolderTreeNode[] = [
  folder(21, "Services", 0),
  folder(22, "People", 1),
];
const [servicesTemplateFolder, peopleTemplateFolder] = templateFolders;

function ca(seed: number, overrides: Partial<CA> & Pick<CA, "commonName" | "type">): CA {
  return {
    id: uuid(23000 + seed),
    parentId: null,
    status: "active",
    keyAlgorithm: "ecdsa-p256",
    serialNumber: `3C0${seed}9A0E41D7B2`,
    certificatePem: PEM_PLACEHOLDER,
    subjectDn: `CN=${overrides.commonName},O=Northwind`,
    issuerDn: null,
    pathLengthConstraint: 0,
    maxValidityDays: 825,
    notBefore: ago(200, "d"),
    notAfter: ahead(1600, "d"),
    ocspCertPem: null,
    crlNumber: 6,
    lastCrlAt: ago(5, "h"),
    crlDistributionUrl: null,
    ocspResponderUrl: null,
    caIssuersUrl: null,
    createdById: people[1].id,
    createdAt: ago(200, "d"),
    updatedAt: ago(5, "h"),
    revokedAt: null,
    revocationReason: null,
    certCount: 0,
    folderId: null,
    sortOrder: 0,
    ...overrides,
  };
}

export const cas: CA[] = [
  {
    ...rootCa,
    certificatePem: PEM_PLACEHOLDER,
    certCount: 0,
    folderId: productionFolder.id,
    sortOrder: 0,
  },
  {
    ...servicesCa,
    certificatePem: PEM_PLACEHOLDER,
    certCount: 6,
    folderId: productionFolder.id,
    sortOrder: 0,
  },
  ca(1, {
    commonName: "Northwind Clients CA",
    type: "intermediate",
    parentId: rootCa.id,
    issuerDn: rootCa.subjectDn,
    keyAlgorithm: "ecdsa-p256",
    maxValidityDays: 397,
    crlDistributionUrl: "https://opfield.example.com/pki/crl/clients.crl",
    ocspResponderUrl: "https://opfield.example.com/pki/ocsp",
    certCount: 3,
    folderId: productionFolder.id,
    sortOrder: 1,
  }),
  ca(2, {
    commonName: "Northwind Lab Root (2021)",
    type: "root",
    keyAlgorithm: "rsa-4096",
    pathLengthConstraint: null,
    maxValidityDays: 1825,
    notBefore: ago(1_800, "d"),
    notAfter: ahead(25, "d"),
    createdAt: ago(1_800, "d"),
    updatedAt: ago(90, "d"),
    lastCrlAt: ago(90, "d"),
    certCount: 1,
  }),
  // Issued under the lab root, so it ends with it.
  ca(3, {
    commonName: "Northwind Lab Issuing CA",
    type: "intermediate",
    parentId: uuid(23002),
    issuerDn: "CN=Northwind Lab Root (2021),O=Northwind",
    keyAlgorithm: "rsa-4096",
    maxValidityDays: 365,
    notBefore: ago(700, "d"),
    notAfter: ahead(25, "d"),
    createdAt: ago(700, "d"),
    updatedAt: ago(90, "d"),
    lastCrlAt: ago(90, "d"),
    certCount: 2,
  }),
  ca(4, {
    commonName: "Northwind Partner Root CA",
    type: "root",
    keyAlgorithm: "ecdsa-p384",
    pathLengthConstraint: 1,
    maxValidityDays: 3650,
    notBefore: ago(120, "d"),
    notAfter: ahead(3530, "d"),
    crlDistributionUrl: "https://opfield.example.com/pki/crl/partner-root.crl",
    createdAt: ago(120, "d"),
    folderId: partnersFolder.id,
    sortOrder: 0,
  }),
  ca(5, {
    commonName: "Partner Exchange CA",
    type: "intermediate",
    parentId: uuid(23004),
    issuerDn: "CN=Northwind Partner Root CA,O=Northwind",
    pathLengthConstraint: 0,
    maxValidityDays: 825,
    notBefore: ago(118, "d"),
    notAfter: ahead(1700, "d"),
    crlDistributionUrl: "https://opfield.example.com/pki/crl/partner-exchange.crl",
    createdAt: ago(118, "d"),
    folderId: partnersFolder.id,
    sortOrder: 0,
  }),
  ca(6, {
    commonName: "Partner Devices CA",
    type: "intermediate",
    parentId: uuid(23005),
    issuerDn: "CN=Partner Exchange CA,O=Northwind",
    maxValidityDays: 397,
    notBefore: ago(110, "d"),
    notAfter: ahead(1600, "d"),
    ocspResponderUrl: "https://opfield.example.com/pki/ocsp",
    createdAt: ago(110, "d"),
    certCount: 14,
    folderId: partnersFolder.id,
    sortOrder: 0,
  }),
];

export const [pkiRootCa, pkiServicesCa, pkiClientsCa, pkiLabCa] = cas;
const pkiPartnerDevicesCa = cas.find((item) => item.id === uuid(23006))!;

// ── Templates ────────────────────────────────────────────────────────────

function template(
  seed: number,
  overrides: Partial<Template> & Pick<Template, "name" | "certType">
): Template {
  return {
    id: uuid(23100 + seed),
    description: null,
    isBuiltin: false,
    keyAlgorithm: "ecdsa-p256",
    validityDays: 90,
    keyUsage: ["digitalSignature", "keyEncipherment"],
    extKeyUsage: ["serverAuth"],
    requireSans: true,
    sanTypes: ["dns"],
    subjectDnFields: { o: "Northwind" },
    crlDistributionPoints: [],
    authorityInfoAccess: {},
    certificatePolicies: [],
    customExtensions: [],
    createdById: people[0].id,
    folderId: null,
    sortOrder: 0,
    createdAt: ago(240, "d"),
    updatedAt: ago(240, "d"),
    ...overrides,
  };
}

export const pkiTemplates: Template[] = [
  template(1, {
    name: "TLS Server",
    description: "Standard TLS server certificate for HTTPS services",
    isBuiltin: true,
    certType: "tls-server",
    validityDays: 365,
    sanTypes: ["dns", "ip"],
    createdById: null,
  }),
  template(2, {
    name: "TLS Client",
    description: "Client certificate for mutual TLS authentication",
    isBuiltin: true,
    certType: "tls-client",
    validityDays: 365,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    requireSans: false,
    sanTypes: ["email"],
    createdById: null,
  }),
  template(3, {
    name: "Code Signing",
    description: "Signs release artifacts and container images",
    isBuiltin: true,
    certType: "code-signing",
    keyAlgorithm: "rsa-4096",
    validityDays: 730,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["codeSigning"],
    requireSans: false,
    sanTypes: [],
    createdById: null,
  }),
  template(4, {
    name: "Internal service (90 days)",
    description: "Short-lived server certificates for services behind Secure Link",
    certType: "tls-server",
    validityDays: 90,
    sanTypes: ["dns", "ip"],
    subjectDnFields: { o: "Northwind", ou: "Platform" },
    crlDistributionPoints: ["https://opfield.example.com/pki/crl/services.crl"],
    authorityInfoAccess: { ocspUrl: "https://opfield.example.com/pki/ocsp" },
    folderId: servicesTemplateFolder.id,
    updatedAt: ago(12, "d"),
  }),
  template(5, {
    name: "Staff mTLS",
    description: "Laptop certificates for the staff VPN and internal tools",
    certType: "tls-client",
    validityDays: 180,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    requireSans: true,
    sanTypes: ["email"],
    subjectDnFields: { o: "Northwind", ou: "Staff", c: "DE" },
    customExtensions: [{ oid: "1.3.6.1.4.1.32473.1.1", critical: false, value: "staff" }],
    folderId: peopleTemplateFolder.id,
    updatedAt: ago(30, "d"),
  }),
  template(6, {
    name: "Mesh sidecar (30 days)",
    description: "Server and client auth for service mesh sidecars",
    certType: "tls-server",
    validityDays: 30,
    extKeyUsage: ["serverAuth", "clientAuth"],
    sanTypes: ["dns", "uri"],
    subjectDnFields: { o: "Northwind", ou: "Mesh" },
    folderId: servicesTemplateFolder.id,
    sortOrder: 1,
    updatedAt: ago(6, "d"),
  }),
  template(7, {
    name: "Contractor mTLS",
    description: "Short-lived client certificates for contractor laptops",
    certType: "tls-client",
    validityDays: 60,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    sanTypes: ["email"],
    subjectDnFields: { o: "Northwind", ou: "Contractors" },
    folderId: peopleTemplateFolder.id,
    sortOrder: 1,
    updatedAt: ago(21, "d"),
  }),
  template(8, {
    name: "S/MIME email",
    description: "Signing and encryption certificates for the ops mailbox",
    certType: "email",
    keyAlgorithm: "rsa-2048",
    validityDays: 365,
    keyUsage: ["digitalSignature", "keyEncipherment"],
    extKeyUsage: ["emailProtection"],
    sanTypes: ["email"],
    updatedAt: ago(45, "d"),
  }),
];

// ── Certificates ─────────────────────────────────────────────────────────

function certificate(
  seed: number,
  overrides: Partial<Certificate> & Pick<Certificate, "commonName" | "caId">
): Certificate {
  const issuer = cas.find((item) => item.id === overrides.caId)!;
  return {
    id: uuid(23200 + seed),
    templateId: pkiTemplates[3].id,
    status: "active",
    type: "tls-server",
    sans: [overrides.commonName],
    serialNumber: `5E0${seed}0C47A91B3F2D`,
    certificatePem: PEM_PLACEHOLDER,
    keyAlgorithm: "ecdsa-p256",
    subjectDn: `CN=${overrides.commonName},OU=Platform,O=Northwind`,
    issuerDn: issuer.subjectDn,
    notBefore: ago(40, "d"),
    notAfter: ahead(50, "d"),
    csrPem: null,
    serverGenerated: true,
    keyUsage: ["digitalSignature", "keyEncipherment"],
    extKeyUsage: ["serverAuth"],
    revokedAt: null,
    revocationReason: null,
    issuedById: people[1].email,
    folderId: null,
    sortOrder: seed,
    createdAt: ago(40, "d"),
    updatedAt: ago(40, "d"),
    ...overrides,
  };
}

export const pkiCertificates: Certificate[] = [
  certificate(1, {
    commonName: "auth.example.com",
    caId: pkiServicesCa.id,
    folderId: meshFolder.id,
    sans: ["auth.example.com", "status.example.com", "10.0.12.31"],
    notBefore: ago(40, "d"),
    notAfter: ahead(325, "d"),
    templateId: pkiTemplates[0].id,
  }),
  certificate(2, {
    commonName: "api.internal.example.com",
    caId: pkiServicesCa.id,
    folderId: meshFolder.id,
    sans: ["api.internal.example.com", "10.0.12.40"],
    notBefore: ago(75, "d"),
    notAfter: ahead(15, "d"),
  }),
  certificate(3, {
    commonName: "orders-db.internal.example.com",
    caId: pkiServicesCa.id,
    folderId: meshFolder.id,
    sans: ["orders-db.internal.example.com"],
    notBefore: ago(12, "d"),
    notAfter: ahead(78, "d"),
  }),
  certificate(4, {
    commonName: "grafana.internal.example.com",
    caId: pkiServicesCa.id,
    folderId: meshFolder.id,
    notBefore: ago(30, "d"),
    notAfter: ahead(60, "d"),
  }),
  certificate(5, {
    commonName: "lena.novak@example.com",
    caId: pkiClientsCa.id,
    folderId: staffFolder.id,
    type: "tls-client",
    sans: ["lena.novak@example.com"],
    subjectDn: "CN=lena.novak@example.com,OU=Staff,O=Northwind,C=DE",
    templateId: pkiTemplates[4].id,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    serverGenerated: false,
    csrPem:
      "-----BEGIN CERTIFICATE REQUEST-----\n(fixture placeholder)\n-----END CERTIFICATE REQUEST-----",
    notBefore: ago(20, "d"),
    notAfter: ahead(160, "d"),
    issuedById: people[2].email,
  }),
  certificate(6, {
    commonName: "sam.patel@example.com",
    caId: pkiClientsCa.id,
    folderId: staffFolder.id,
    type: "tls-client",
    sans: ["sam.patel@example.com"],
    subjectDn: "CN=sam.patel@example.com,OU=Staff,O=Northwind,C=DE",
    templateId: pkiTemplates[4].id,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    notBefore: ago(9, "d"),
    notAfter: ahead(171, "d"),
  }),
  certificate(7, {
    commonName: "release-signing",
    caId: pkiLabCa.id,
    type: "code-signing",
    sans: [],
    keyAlgorithm: "rsa-4096",
    subjectDn: "CN=release-signing,O=Northwind",
    templateId: pkiTemplates[2].id,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["codeSigning"],
    notBefore: ago(400, "d"),
    notAfter: ahead(25, "d"),
  }),
  certificate(8, {
    commonName: "legacy-vpn.example.com",
    caId: pkiServicesCa.id,
    folderId: meshFolder.id,
    status: "revoked",
    revokedAt: ago(18, "d"),
    revocationReason: "superseded",
    notBefore: ago(120, "d"),
    notAfter: ahead(245, "d"),
  }),
  certificate(9, {
    commonName: "edge-gw-01.partner.example.net",
    caId: pkiPartnerDevicesCa.id,
    type: "tls-client",
    sans: ["edge-gw-01.partner.example.net", "192.0.2.41"],
    subjectDn: "CN=edge-gw-01.partner.example.net,OU=Partners,O=Northwind",
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    notBefore: ago(60, "d"),
    notAfter: ahead(305, "d"),
  }),
];

export const authCertificate = pkiCertificates[0];

const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });

/**
 * The PKI lists as the operator left them: every folder open. The PKI folder
 * scopes are not in the token scope catalog yet (backend work), so the fixture
 * operator gets them here to see folder management and drag and drop.
 */
export function preparePkiLists() {
  useAuthStore.setState((state) => ({
    user: state.user && {
      ...state.user,
      scopes: [
        ...state.user.scopes,
        "pki:ca:folders:manage",
        "pki:cert:folders:manage",
        "pki:templates:folders:manage",
      ],
    },
  }));
  expandFolders(
    "pki-ca",
    caFolders.map((item) => item.id)
  );
  expandFolders(
    "pki-certificate",
    certificateFolders.map((item) => item.id)
  );
  expandFolders("pki-template", [
    "pki-templates-builtin",
    ...templateFolders.map((item) => item.id),
  ]);
}

/** CAs, issued certificates and PKI templates. */
export function pkiHandlers() {
  return [
    http.get("*/api/cas", () => ok(cas)),
    // Before `/cas/:id` and `/certificates/:id`, which would take "folders" for an id.
    http.get("*/api/cas/folders", () => wrapped(caFolders)),
    http.get("*/api/certificates/folders", () => wrapped(certificateFolders)),
    http.get("*/api/cas/:id", ({ params }) => {
      const found = cas.find((item) => item.id === params.id);
      return found ? ok(found) : notFound();
    }),
    http.get("*/api/certificates", ({ request }) => {
      const url = new URL(request.url);
      const caId = url.searchParams.get("caId");
      const status = url.searchParams.get("status");
      const type = url.searchParams.get("type");
      const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
      const rows = pkiCertificates.filter(
        (cert) =>
          (!caId || cert.caId === caId) &&
          (!status || status === "all" || cert.status === status) &&
          (!type || type === "all" || cert.type === type)
      );
      return ok({
        data: rows.slice(0, limit),
        pagination: { page: 1, limit, total: rows.length, totalPages: 1 },
      });
    }),
    http.get("*/api/certificates/:id", ({ params }) => {
      const found = pkiCertificates.find((item) => item.id === params.id);
      return found ? ok(found) : notFound();
    }),
    http.get("*/api/templates", () => ok(pkiTemplates)),
    http.get("*/api/templates/folders", () => wrapped(templateFolders)),
  ];
}
