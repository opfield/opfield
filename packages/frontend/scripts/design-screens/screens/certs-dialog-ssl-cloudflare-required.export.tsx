import { screen, within } from "@testing-library/react";
import {
  noCloudflareHandlers,
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

it("certs-dialog-ssl-cloudflare-required", async () => {
  await exportScreen({
    id: "certs-dialog-ssl-cloudflare-required",
    title: "Add SSL Certificate · Cloudflare not configured",
    group: "Certificates",
    route: "/certificates",
    handlers: [
      ...noCloudflareHandlers(),
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
      await pickChallenge(user, dialog, "Automatic DNS via Cloudflare");
      await user.click(within(dialog).getByRole("button", { name: "Request Certificate" }));
      await settleDialog(await screen.findByRole("dialog", { name: "Configure Cloudflare" }));
    },
    notes: [
      "Choosing automatic DNS without a Cloudflare connector: the request stops and points to the integration settings.",
    ],
  });
});
