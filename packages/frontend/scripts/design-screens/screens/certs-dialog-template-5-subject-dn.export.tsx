import { screen } from "@testing-library/react";
import { createTemplateUpTo } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-template-5-subject-dn", async () => {
  await exportScreen({
    id: "certs-dialog-template-5-subject-dn",
    title: "Create Template · Subject DN",
    group: "Certificates",
    route: "/certificates/templates",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    height: 1100,
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("Staff mTLS");
    },
    interact: async (user) => {
      await createTemplateUpTo(user, 4);
    },
    notes: [
      'Step 5 of 8 of creating the "Mesh workload (mTLS)" PKI certificate template; the earlier steps are filled.',
    ],
  });
});
