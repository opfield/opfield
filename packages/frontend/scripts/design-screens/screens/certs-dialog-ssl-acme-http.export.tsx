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

it("certs-dialog-ssl-acme-http", async () => {
  await exportScreen({
    id: "certs-dialog-ssl-acme-http",
    title: "Add SSL Certificate · Let's Encrypt via HTTP",
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
      await pickChallenge(user, dialog, "HTTP validation");
      await settleDialog(dialog);
    },
    notes: [
      "HTTP-01 validation through the Ingress node; no DNS records needed, no wildcard domains.",
    ],
  });
});
