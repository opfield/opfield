import { screen, within } from "@testing-library/react";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { exportScreen } from "../harness";

it("ingress-routes-dialog-move-to-folder", async () => {
  await exportScreen({
    id: "ingress-routes-dialog-move-to-folder",
    title: "Routes · Move to Folder",
    group: "Ingress",
    route: "/routes",
    handlers: routeHandlers(),
    before: expandRouteFolders,
    ready: async () => {
      await screen.findByText("docs.example.org");
    },
    interact: async (user) => {
      await chooseRowAction(user, "docs.example.org", "Route actions", "Move to folder...");
      const dialog = await settleDialog("Move to Folder");
      await user.click(within(dialog).getByRole("button", { name: /Production/ }));
    },
    notes: ["Moving the ungrouped docs.example.org route into the Production folder."],
  });
});
