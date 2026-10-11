import { screen } from "@testing-library/react";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { exportScreen } from "../harness";

it("ingress-routes-dialog-rename-folder", async () => {
  await exportScreen({
    id: "ingress-routes-dialog-rename-folder",
    title: "Routes · Rename Folder",
    group: "Ingress",
    route: "/routes",
    handlers: routeHandlers(),
    before: expandRouteFolders,
    ready: async () => {
      await screen.findByText("legacy-admin.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "Internal", "Folder actions", "Rename");
      await settleDialog("Rename Folder");
      await screen.findByDisplayValue("Internal");
    },
    notes: [
      "Rename in the folder row menu opens the same dialog as Create Folder, with the current name prefilled.",
    ],
  });
});
