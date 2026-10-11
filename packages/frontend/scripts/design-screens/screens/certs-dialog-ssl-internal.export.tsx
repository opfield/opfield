import { screen, within } from "@testing-library/react";
import { openAddSSLCertificate, settleDialog } from "../fixtures/certs/creation";
import { pkiHandlers } from "../fixtures/certs/pki";
import { domainsHandlers } from "../fixtures/edge/domains";
import { sslHandlers } from "../fixtures/edge/ssl";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-ssl-internal", async () => {
  await exportScreen({
    id: "certs-dialog-ssl-internal",
    title: "Add SSL Certificate · Internal CA",
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
      await user.click(within(dialog).getByRole("tab", { name: "Internal CA" }));
      await user.click(within(dialog).getByRole("combobox", { name: "PKI certificate" }));
      await user.click(await screen.findByRole("option", { name: "auth.example.com" }));
      await user.type(
        within(dialog).getByPlaceholderText("Auto-generated from certificate"),
        "auth-internal"
      );
      await settleDialog(dialog);
    },
    notes: ["Linking a certificate the internal PKI issued, so routes can serve it."],
  });
});
