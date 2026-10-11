import { screen, within } from "@testing-library/react";
import {
  acmeDnsRecordsHandlers,
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

it("certs-dialog-ssl-acme-dns-records", async () => {
  await exportScreen({
    id: "certs-dialog-ssl-acme-dns-records",
    title: "Add SSL Certificate · DNS records to add",
    group: "Certificates",
    route: "/certificates",
    handlers: [
      ...acmeDnsRecordsHandlers(),
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
      await user.click(within(dialog).getByRole("button", { name: "Request Certificate" }));
      await within(dialog).findByText("_acme-challenge.billing.example.com");
      await settleDialog(dialog);
    },
    notes: [
      "The pending state of a manual DNS-01 request: the TXT record to add, then Verify DNS (or Cancel the request). The dialog cannot be dismissed while the request is pending.",
    ],
  });
});
