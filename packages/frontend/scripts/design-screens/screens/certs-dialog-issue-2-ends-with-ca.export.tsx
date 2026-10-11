import { screen } from "@testing-library/react";
import { issueCertificateUpTo } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-issue-2-ends-with-ca", async () => {
  await exportScreen({
    id: "certs-dialog-issue-2-ends-with-ca",
    title: "Issue Certificate · Ends with the CA",
    group: "Certificates",
    route: "/certificates/pki",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("orders-db.internal.example.com");
    },
    interact: async (user) => {
      await issueCertificateUpTo(
        user,
        {
          ca: "Northwind Lab Issuing CA",
          template: "Code Signing",
          commonName: "nightly-build-signing",
        },
        2
      );
    },
    notes: [
      "Step 2 with a 730-day code signing template under the lab CA that expires in 25 days: the certificate will end with the CA.",
    ],
  });
});
