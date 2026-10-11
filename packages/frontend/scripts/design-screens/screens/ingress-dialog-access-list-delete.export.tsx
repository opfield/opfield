import { screen } from "@testing-library/react";
import { accessListHandlers } from "../fixtures/ingress/access-lists";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-dialog-access-list-delete", async () => {
  await exportScreen({
    id: "ingress-dialog-access-list-delete",
    title: "Access Lists · Delete Access List",
    group: "Ingress",
    route: "/routes/access-lists",
    handlers: [...accessListHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Support portal");
    },
    interact: async (user) => {
      await chooseRowAction(user, "Partner API allowlist", "Access list actions", "Delete");
      await settleDialog("Delete Access List");
    },
    notes: ["Deleting an access list no route uses."],
  });
});
