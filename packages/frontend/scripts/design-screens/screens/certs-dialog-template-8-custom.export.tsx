import { screen } from "@testing-library/react";
import { createTemplateUpTo } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-template-8-custom", async () => {
  await exportScreen({
    id: "certs-dialog-template-8-custom",
    title: "Create Template · Custom",
    group: "Certificates",
    route: "/certificates/templates",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    height: 1100,
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("Staff mTLS");
    },
    interact: async (user) => {
      await createTemplateUpTo(user, 7);
    },
    notes: [
      'Step 8 of 8 of creating the "Mesh workload (mTLS)" PKI certificate template; the earlier steps are filled.',
    ],
  });
});
