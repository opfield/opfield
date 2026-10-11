import { screen, within } from "@testing-library/react";
import {
  issueCertificateUpTo,
  issueHandlers,
  paymentsCertificate,
} from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-issue-4-issued", async () => {
  await exportScreen({
    id: "certs-dialog-issue-4-issued",
    title: "Issue Certificate · Issued",
    group: "Certificates",
    route: "/certificates/pki",
    handlers: [...issueHandlers(), ...pkiHandlers(), ...backgroundPrewarmHandlers()],
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("orders-db.internal.example.com");
    },
    interact: async (user) => {
      const dialog = await issueCertificateUpTo(user, paymentsCertificate, 3);
      await user.click(within(dialog).getByRole("button", { name: "Issue Certificate" }));
      await screen.findByText("Certificate issued for payments.internal.example.com");
      await screen.findByText("payments.internal.example.com");
    },
    notes: [
      "After issuing: the dialog closes with a confirmation and the new certificate is in the list (ungrouped).",
      "There is no one-time key view: the server keeps the key, which the certificate page downloads.",
    ],
  });
});
