import { screen } from "@testing-library/react";
import { issueCertificateUpTo, paymentsCertificate } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-issue-2-subject", async () => {
  await exportScreen({
    id: "certs-dialog-issue-2-subject",
    title: "Issue Certificate · Subject details",
    group: "Certificates",
    route: "/certificates/pki",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("orders-db.internal.example.com");
    },
    interact: async (user) => {
      await issueCertificateUpTo(user, paymentsCertificate, 2);
    },
    notes: [
      "Step 2: common name, two SANs (DNS and IP) and the subject DN for payments.internal.example.com.",
    ],
  });
});
