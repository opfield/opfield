import { screen, within } from "@testing-library/react";
import { openAddSSLCertificate, placeholderPem, settleDialog } from "../fixtures/certs/creation";
import { pkiHandlers } from "../fixtures/certs/pki";
import { domainsHandlers } from "../fixtures/edge/domains";
import { sslHandlers } from "../fixtures/edge/ssl";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-ssl-upload", async () => {
  await exportScreen({
    id: "certs-dialog-ssl-upload",
    title: "Add SSL Certificate · Upload",
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
      await user.click(within(dialog).getByRole("tab", { name: "Upload" }));
      await user.type(
        within(dialog).getByPlaceholderText("My Certificate"),
        "Intranet wildcard (2026)"
      );
      const [certificate, key, chain] = within(dialog).getAllByRole("textbox").slice(1);
      await user.click(certificate);
      await user.paste(placeholderPem("CERTIFICATE"));
      await user.click(key);
      await user.paste(placeholderPem("PRIVATE KEY"));
      await user.click(chain);
      await user.paste(placeholderPem("CERTIFICATE"));
      await settleDialog(dialog);
    },
    notes: [
      "Uploading a certificate bought elsewhere: certificate, private key and chain as PEM (placeholders).",
    ],
  });
});
