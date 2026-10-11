import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { chooseRowAction } from "../fixtures/ingress/interactions";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { exportScreen } from "../harness";

it("ingress-routes-dialog-delete-folder", async () => {
  await exportScreen({
    id: "ingress-routes-dialog-delete-folder",
    title: "Routes · Delete Folder",
    group: "Ingress",
    route: "/routes",
    handlers: routeHandlers(),
    before: expandRouteFolders,
    ready: async () => {
      await screen.findByText("legacy-admin.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "Internal", "Folder actions", "Delete");
      await screen.findByRole("dialog", { name: "Delete Folder" });
      await waitForReveal();
    },
    notes: ["Deleting the Internal folder; its two routes would move to ungrouped."],
  });
});
