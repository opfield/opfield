/**
 * Certificate creation flows for the creation specs: each helper drives one
 * dialog through the UI up to a given state, with realistic values, and the
 * handlers answer the requests those dialogs make.
 * Seeds 23900-23999 belong to this file.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { http } from "msw";
import { waitForReveal } from "@/test/reveal";
import type { Certificate, SSLCertificate } from "@/types";
import { ok, wrapped } from "../../handlers";
import type { UserEventApi } from "../../harness";
import { releaseAnimatedHeights } from "../docker/jsdom-shims";
import { sslCertificates } from "../edge/ssl";
import { ago, ahead, uuid } from "../time";
import { pkiCertificates } from "./pki";

type Dialog = HTMLElement;

async function pick(user: UserEventApi, trigger: HTMLElement, option: string | RegExp) {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}

async function next(user: UserEventApi, dialog: Dialog) {
  await user.click(within(dialog).getByRole("button", { name: /^Next/ }));
}

/** Number inputs: typing into them appends to the reset default, so set the value. */
function setNumber(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

/** Waits for the dialog to reveal and releases its animated heights. */
export async function settleDialog(dialog: Dialog) {
  await waitForReveal();
  await releaseAnimatedHeights(dialog);
}

// ── PKI template wizard ──────────────────────────────────────────────────

/** Steps of the template wizard, in order (`WIZARD_STEPS`). */
export const TEMPLATE_STEPS = [
  "General",
  "Key Usage",
  "Purpose",
  "SANs",
  "Subject DN",
  "Endpoints",
  "Policies",
  "Custom",
] as const;

/**
 * Creates the "Mesh workload (mTLS)" template up to `lastStep` (an index into
 * TEMPLATE_STEPS), filling every step on the way.
 */
export async function createTemplateUpTo(user: UserEventApi, lastStep: number) {
  await user.click(screen.getByRole("button", { name: "Create Template" }));
  const dialog = await screen.findByRole("dialog", { name: "Create Template" });
  const inDialog = within(dialog);
  const steps: Array<() => Promise<void>> = [
    async () => {
      await user.type(
        inDialog.getByPlaceholderText("e.g., Mutual TLS Server+Client"),
        "Mesh workload (mTLS)"
      );
      await user.type(
        inDialog.getByPlaceholderText("What this template is for"),
        "Server and client certificates for service mesh workloads"
      );
      await pick(user, inDialog.getAllByRole("combobox")[1], "ECDSA-P384");
      setNumber(inDialog.getByDisplayValue("365"), "30");
    },
    async () => {
      await user.click(inDialog.getByRole("checkbox", { name: /^Digital Signature/ }));
      await user.click(inDialog.getByRole("checkbox", { name: /^Key Agreement/ }));
    },
    async () => {
      await user.click(inDialog.getByRole("checkbox", { name: /^TLS Server Authentication/ }));
      await user.click(inDialog.getByRole("checkbox", { name: /^TLS Client Authentication/ }));
    },
    async () => {
      await user.click(inDialog.getByRole("checkbox", { name: /^URIs/ }));
    },
    async () => {
      await user.type(inDialog.getByPlaceholderText("e.g., Acme Corp"), "Northwind");
      await user.type(inDialog.getByPlaceholderText("e.g., Engineering"), "Platform");
      await user.type(inDialog.getByPlaceholderText("City"), "Berlin");
      await user.type(inDialog.getByPlaceholderText("State/Province"), "Berlin");
      await user.type(inDialog.getByPlaceholderText("US"), "DE");
    },
    async () => {
      await user.click(inDialog.getByRole("button", { name: "Add CRL URL" }));
      await user.type(
        inDialog.getByPlaceholderText("http://crl.example.com/ca.crl"),
        "https://opfield.example.com/pki/crl/services.crl"
      );
      await user.type(
        inDialog.getByPlaceholderText("http://ca.example.com/cert.pem"),
        "https://opfield.example.com/pki/ca/services.crt"
      );
    },
    async () => {
      await user.click(inDialog.getByRole("button", { name: "Add Policy" }));
      await user.type(
        inDialog.getByPlaceholderText("Policy OID (e.g., 2.23.140.1.2.1)"),
        "1.3.6.1.4.1.32473.2.1"
      );
      await user.type(
        inDialog.getByPlaceholderText("CPS URI (optional, e.g., https://example.com/cps)"),
        "https://pki.example.com/cps"
      );
    },
    async () => {
      await user.click(inDialog.getByRole("button", { name: "Add Extension" }));
      await user.type(
        inDialog.getByPlaceholderText("OID (e.g., 1.2.3.4.5.6.7)"),
        "1.3.6.1.4.1.32473.1.1"
      );
      await user.type(inDialog.getByPlaceholderText("Hex-encoded DER value"), "0c046d657368");
    },
  ];
  for (const [index, fill] of steps.entries()) {
    await fill();
    if (index === lastStep) break;
    await next(user, dialog);
  }
  await settleDialog(dialog);
}

// ── Issue Certificate ────────────────────────────────────────────────────

export interface IssueFlow {
  ca: string;
  template?: string;
  commonName?: string;
  sans?: string[];
  subject?: { o?: string; ou?: string; c?: string };
}

/** The payments service certificate from the services CA. */
export const paymentsCertificate: IssueFlow = {
  ca: "Northwind Services CA",
  template: "Internal service (90 days)",
  commonName: "payments.internal.example.com",
  sans: ["payments.internal.example.com", "10.0.12.52"],
  subject: { o: "Northwind", ou: "Platform", c: "DE" },
};

/** Opens Issue Certificate from the certificate list and fills it up to `lastStep` (1-3). */
export async function issueCertificateUpTo(user: UserEventApi, flow: IssueFlow, lastStep: number) {
  await user.click(screen.getByRole("button", { name: "Issue Certificate" }));
  const dialog = await screen.findByRole("dialog", { name: "Issue Certificate" });
  await waitForReveal();
  const inDialog = within(dialog);
  const [caPicker, templatePicker] = inDialog.getAllByRole("combobox");
  await pick(user, caPicker, flow.ca);
  if (flow.template) await pick(user, templatePicker, flow.template);
  if (lastStep > 1) {
    await next(user, dialog);
    await inDialog.findByPlaceholderText("e.g., api.example.com");
    if (flow.commonName) {
      await user.type(inDialog.getByPlaceholderText("e.g., api.example.com"), flow.commonName);
    }
    for (const san of flow.sans ?? []) {
      await user.type(inDialog.getByPlaceholderText("e.g., *.example.com or 192.168.1.1"), san);
      await user.click(inDialog.getByRole("button", { name: "Add SAN" }));
    }
    if (flow.subject?.o)
      await user.type(inDialog.getByPlaceholderText("Organization (O)"), flow.subject.o);
    if (flow.subject?.ou)
      await user.type(inDialog.getByPlaceholderText("Org Unit (OU)"), flow.subject.ou);
    if (flow.subject?.c)
      await user.type(inDialog.getByPlaceholderText("Country (C)"), flow.subject.c);
  }
  if (lastStep > 2) {
    await next(user, dialog);
    await inDialog.findByText("Review");
  }
  await settleDialog(dialog);
  return dialog;
}

const issuedPayments: Certificate = {
  ...pkiCertificates[0],
  id: uuid(23901),
  commonName: "payments.internal.example.com",
  sans: ["payments.internal.example.com", "10.0.12.52"],
  subjectDn: "CN=payments.internal.example.com,OU=Platform,O=Northwind,C=DE",
  serialNumber: "5E0990C47A91B3F2D",
  notBefore: ago(0, "m"),
  notAfter: ahead(90, "d"),
  folderId: null,
  createdAt: ago(0, "m"),
  updatedAt: ago(0, "m"),
};

/** Issuing answers with the new certificate; the list then includes it. */
export function issueHandlers() {
  let issued = false;
  return [
    http.post("*/api/certificates", () => {
      issued = true;
      return ok({ certificate: issuedPayments, privateKeyPem: "(fixture placeholder)" });
    }),
    http.get("*/api/certificates", ({ request }) => {
      if (!issued) return;
      const url = new URL(request.url);
      if (url.searchParams.get("caId")) return;
      const rows = [issuedPayments, ...pkiCertificates.filter((cert) => cert.status === "active")];
      return ok({
        data: rows,
        pagination: { page: 1, limit: 25, total: rows.length, totalPages: 1 },
      });
    }),
  ];
}

// ── Create CA ────────────────────────────────────────────────────────────

/** Fills the CA form below the parent picker. */
export async function fillCAForm(
  user: UserEventApi,
  dialog: Dialog,
  values: {
    commonName: string;
    algorithm: string;
    years: string;
    pathLength: string;
    maxDays: string;
  }
) {
  const inDialog = within(dialog);
  await user.type(inDialog.getByPlaceholderText(/^e\.g\., My Org/), values.commonName);
  await pick(user, inDialog.getAllByRole("combobox").at(-1)!, values.algorithm);
  setNumber(inDialog.getByDisplayValue("10"), values.years);
  setNumber(inDialog.getByPlaceholderText("Optional"), values.pathLength);
  setNumber(inDialog.getByDisplayValue("365"), values.maxDays);
  await settleDialog(dialog);
}

// ── Add SSL Certificate ──────────────────────────────────────────────────

/** Opens Add SSL Certificate from the SSL certificate list. */
export async function openAddSSLCertificate(user: UserEventApi) {
  await user.click(screen.getByRole("button", { name: "Add Certificate" }));
  const dialog = await screen.findByRole("dialog", { name: "Add SSL Certificate" });
  await waitForReveal();
  return dialog;
}

/** Picks a registered domain in the Let's Encrypt domain field. */
export async function pickACMEDomain(user: UserEventApi, dialog: Dialog, domain: string) {
  const input = within(dialog)
    .getAllByRole("combobox")
    .find((element) => element.tagName === "INPUT")!;
  await user.click(input);
  await user.click(
    await screen.findByRole("button", { name: new RegExp(`^${domain.replace(".", "\\.")}`) })
  );
  // Closes the suggestion list.
  await user.click(within(dialog).getByText("Domains"));
}

export async function pickChallenge(user: UserEventApi, dialog: Dialog, label: string) {
  await pick(user, within(dialog).getByRole("combobox", { name: "Challenge Type" }), label);
}

const pendingBilling: SSLCertificate = {
  ...sslCertificates[0],
  id: uuid(23911),
  name: "billing.example.com",
  domainNames: ["billing.example.com"],
  status: "pending",
  acmeChallengeType: "dns-01",
  acmePendingOperation: "issue",
  notBefore: null,
  notAfter: null,
  createdAt: ago(0, "m"),
  updatedAt: ago(0, "m"),
};

/** A manual DNS-01 request answers with the TXT records to add. */
export function acmeDnsRecordsHandlers() {
  const challenges = [
    {
      domain: "billing.example.com",
      recordName: "_acme-challenge.billing.example.com",
      recordValue: "Xq3v9fixturePLACEHOLDERtokenNOTreal7Hk2Lm0",
    },
  ];
  return [
    http.post("*/api/ssl-certificates/acme", () =>
      wrapped({
        status: "pending_dns_verification",
        certificate: { ...pendingBilling, acmePendingChallenges: challenges },
        challenges,
      })
    ),
  ];
}

/** An installation with no registered domain yet. */
export function noDomainHandlers() {
  return [
    http.get("*/api/domains", () =>
      ok({ data: [], pagination: { page: 1, limit: 1, total: 0, totalPages: 0 } })
    ),
  ];
}

/** An installation without a Cloudflare connector. */
export function noCloudflareHandlers() {
  return [http.get("*/api/integrations/cloudflare/connectors", () => wrapped([]))];
}

/** A PEM block with placeholder content, never real key material. */
export function placeholderPem(label: string) {
  return [
    `-----BEGIN ${label}-----`,
    "MIIBfixturePLACEHOLDERnotAREALpemBLOCKforDESIGNscreensONLYexample",
    "AAAAexampleEXAMPLEexampleEXAMPLEexampleEXAMPLEexampleEXAMPLEexampl",
    `-----END ${label}-----`,
  ].join("\n");
}
