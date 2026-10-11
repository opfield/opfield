import { screen } from "@testing-library/react";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-templates-pki", async () => {
  await exportScreen({
    id: "ingress-templates-pki",
    title: "Templates · PKI Certificates",
    group: "Ingress",
    route: "/certificates/templates",
    before: preparePkiLists,
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Staff mTLS");
      await screen.findByText("S/MIME email");
    },
    notes: [
      "Three built-in certificate templates in the read-only Built-in folder; five custom ones in two folders plus ungrouped.",
      "Folder management and drag and drop need pki:templates:folders:manage (backend work); the fixture operator holds it.",
    ],
  });
});
