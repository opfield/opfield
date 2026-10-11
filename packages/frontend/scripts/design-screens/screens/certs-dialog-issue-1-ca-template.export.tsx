import { screen } from "@testing-library/react";
import { issueCertificateUpTo, paymentsCertificate } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-issue-1-ca-template", async () => {
  await exportScreen({
    id: "certs-dialog-issue-1-ca-template",
    title: "Issue Certificate · CA and template",
    group: "Certificates",
    route: "/certificates/pki",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("orders-db.internal.example.com");
    },
    interact: async (user) => {
      await issueCertificateUpTo(user, paymentsCertificate, 1);
    },
    notes: [
      "Step 1: the services CA with the 90-day internal service template, which fixes type, algorithm and validity.",
    ],
  });
});
