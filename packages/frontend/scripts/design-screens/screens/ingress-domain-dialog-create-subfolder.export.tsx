import { screen } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-create-subfolder", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-create-subfolder",
    title: "Domains · Create Subfolder",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "Staging", "Folder actions", "Add subfolder");
      await settleDialog("Create Folder");
      await user.type(screen.getByPlaceholderText("Folder name"), "Preview environments");
    },
    notes: ["A subfolder inside the Staging domain folder."],
  });
});
