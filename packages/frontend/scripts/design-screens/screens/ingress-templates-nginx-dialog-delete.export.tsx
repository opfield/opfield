import { screen } from "@testing-library/react";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import {
  nginxTemplateHandlers,
  prepareNginxTemplateList,
} from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-templates-nginx-dialog-delete", async () => {
  await exportScreen({
    id: "ingress-templates-nginx-dialog-delete",
    title: "Templates · Nginx Config · Delete Template",
    group: "Ingress",
    route: "/routes/templates",
    before: prepareNginxTemplateList,
    handlers: [...nginxTemplateHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Long-poll API");
    },
    interact: async (user) => {
      await chooseRowAction(
        user,
        "Static site (long cache)",
        "Actions for Static site (long cache)",
        "Delete"
      );
      await settleDialog("Delete Template");
    },
    notes: ["Deleting a custom template from the list's row menu."],
  });
});
