import { screen } from "@testing-library/react";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-certificates", async () => {
  await exportScreen({
    id: "certs-certificates",
    title: "Certificates",
    group: "Certificates",
    route: "/certificates/pki",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("orders-db.internal.example.com");
      // The issuing CA badges need the CA list.
      await screen.findByText("Partner Devices CA");
    },
    notes: [
      "Active certificates issued by the internal CAs (the default filter hides revoked ones), in two folders plus ungrouped.",
      "Folder management and drag and drop need pki:cert:folders:manage (backend work); the fixture operator holds it.",
    ],
  });
});
