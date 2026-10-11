import { screen } from "@testing-library/react";
import { openAddSSLCertificate, pickACMEDomain, settleDialog } from "../fixtures/certs/creation";
import { pkiHandlers } from "../fixtures/certs/pki";
import { domainsHandlers } from "../fixtures/edge/domains";
import { sslHandlers } from "../fixtures/edge/ssl";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-ssl-acme-cloudflare", async () => {
  await exportScreen({
    id: "certs-dialog-ssl-acme-cloudflare",
    title: "Add SSL Certificate · Let's Encrypt via Cloudflare DNS",
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
      await settleDialog(dialog);
    },
    notes: [
      "Let's Encrypt for billing.example.com; with a Cloudflare connector, DNS-01 through Cloudflare is the default.",
    ],
  });
});
