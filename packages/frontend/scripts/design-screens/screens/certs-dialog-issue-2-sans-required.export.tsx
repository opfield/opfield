import { screen } from "@testing-library/react";
import { issueCertificateUpTo } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-issue-2-sans-required", async () => {
  await exportScreen({
    id: "certs-dialog-issue-2-sans-required",
    title: "Issue Certificate · SAN required",
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
        { ca: "Northwind Services CA", commonName: "grafana-next.internal.example.com" },
        2
      );
    },
    notes: [
      "Step 2 without a template or SAN: a TLS server certificate needs at least one SAN, so Next stays disabled.",
    ],
  });
});
