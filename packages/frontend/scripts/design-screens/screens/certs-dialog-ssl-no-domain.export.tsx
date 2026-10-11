import { screen } from "@testing-library/react";
import { noDomainHandlers, settleDialog } from "../fixtures/certs/creation";
import { pkiHandlers } from "../fixtures/certs/pki";
import { domainsHandlers } from "../fixtures/edge/domains";
import { sslHandlers } from "../fixtures/edge/ssl";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-ssl-no-domain", async () => {
  await exportScreen({
    id: "certs-dialog-ssl-no-domain",
    title: "Add SSL Certificate · No domain yet",
    group: "Certificates",
    route: "/certificates",
    handlers: [
      ...noDomainHandlers(),
      ...sslHandlers(),
      ...domainsHandlers(),
      ...pkiHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    ready: async () => {
      await screen.findAllByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add Certificate" }));
      await settleDialog(await screen.findByRole("dialog", { name: "Add a Domain First" }));
    },
    notes: [
      "With no registered domain, Add Certificate first offers to add one or to continue with a manual certificate.",
    ],
  });
});
