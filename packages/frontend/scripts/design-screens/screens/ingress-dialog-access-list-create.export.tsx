import { screen, within } from "@testing-library/react";
import { accessListHandlers } from "../fixtures/ingress/access-lists";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-dialog-access-list-create", async () => {
  await exportScreen({
    id: "ingress-dialog-access-list-create",
    title: "Access Lists · Create Access List",
    group: "Ingress",
    route: "/routes/access-lists",
    handlers: [...accessListHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Support portal");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add Access List" }));
      const dialog = await settleDialog("Create Access List");
      await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Finance team");
      await user.type(
        within(dialog).getByRole("textbox", { name: "Description" }),
        "Accounting office network"
      );
      await settleDialog("Create Access List");
    },
    notes: [
      "A new access list before any rule is added: no IP rules (every address passes) and basic authentication off.",
    ],
  });
});
