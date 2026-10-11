import { screen } from "@testing-library/react";
import {
  openAddSSLCertificate,
  pickACMEDomain,
  pickChallenge,
  settleDialog,
} from "../fixtures/certs/creation";
import { pkiHandlers } from "../fixtures/certs/pki";
import { domainsHandlers } from "../fixtures/edge/domains";
import { sslHandlers } from "../fixtures/edge/ssl";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-ssl-acme-dns-manual", async () => {
  await exportScreen({
    id: "certs-dialog-ssl-acme-dns-manual",
    title: "Add SSL Certificate · Let's Encrypt via manual DNS",
    group: "Certificates",
    route: "/certificates",
    handlers: [
      ...sslHandlers(),
      ...domainsHandlers(),
      ...pkiHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    ready: async () => {
      await screen.findAllByText("grafana.example.com");
    },
    interact: async (user) => {
      const dialog = await openAddSSLCertificate(user);
      await pickACMEDomain(user, dialog, "billing.example.com");
      await pickChallenge(user, dialog, "Manual DNS validation");
      await settleDialog(dialog);
    },
    notes: ["Manual DNS-01: after the request, the dialog shows the TXT records to add."],
  });
});
