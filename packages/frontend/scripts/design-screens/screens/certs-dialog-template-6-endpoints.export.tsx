import { screen } from "@testing-library/react";
import { createTemplateUpTo } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-template-6-endpoints", async () => {
  await exportScreen({
    id: "certs-dialog-template-6-endpoints",
    title: "Create Template · Endpoints",
    group: "Certificates",
    route: "/certificates/templates",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    height: 1100,
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("Staff mTLS");
    },
    interact: async (user) => {
      await createTemplateUpTo(user, 5);
    },
    notes: [
      'Step 6 of 8 of creating the "Mesh workload (mTLS)" PKI certificate template; the earlier steps are filled.',
    ],
  });
});
