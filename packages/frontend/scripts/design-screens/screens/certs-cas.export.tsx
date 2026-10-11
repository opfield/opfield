import { screen } from "@testing-library/react";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-cas", async () => {
  await exportScreen({
    id: "certs-cas",
    title: "Certificate Authorities",
    group: "Certificates",
    route: "/certificates/authorities",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("Partner Devices CA");
    },
    notes: [
      "CA hierarchies in folders: Production (root, two intermediates) and Partners (root, two nested levels); the lab chain is ungrouped.",
      "The 2021 lab root and its issuing CA expire in 25 days.",
      "Folder management and drag and drop need pki:ca:folders:manage (backend work); the fixture operator holds it.",
    ],
  });
});
