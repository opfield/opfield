import { screen } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-delete-folder", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-delete-folder",
    title: "Domains · Delete Folder",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "Staging", "Folder actions", "Delete");
      await settleDialog("Delete Folder");
    },
    notes: ["Deleting the Staging folder; its domain moves to ungrouped."],
  });
});
