import { screen } from "@testing-library/react";
import { settleDialog } from "../fixtures/ingress/interactions";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { exportScreen } from "../harness";

it("ingress-routes-dialog-create-folder", async () => {
  await exportScreen({
    id: "ingress-routes-dialog-create-folder",
    title: "Routes · Create Folder",
    group: "Ingress",
    route: "/routes",
    handlers: routeHandlers(),
    before: expandRouteFolders,
    ready: async () => {
      await screen.findByText("legacy-admin.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add Folder" }));
      await settleDialog("Create Folder");
      await user.type(screen.getByPlaceholderText("Folder name"), "Staging");
    },
    notes: ["Add Folder on the routes list: a new top-level folder named Staging."],
  });
});
