import { screen } from "@testing-library/react";
import { issueCertificateUpTo, paymentsCertificate } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-issue-3-review", async () => {
  await exportScreen({
    id: "certs-dialog-issue-3-review",
    title: "Issue Certificate · Review",
    group: "Certificates",
    route: "/certificates/pki",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("orders-db.internal.example.com");
    },
    interact: async (user) => {
      await issueCertificateUpTo(user, paymentsCertificate, 3);
    },
    notes: ["Step 3: the summary before issuing."],
  });
});
