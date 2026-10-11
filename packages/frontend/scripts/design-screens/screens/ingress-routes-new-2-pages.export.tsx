import { screen } from "@testing-library/react";
import {
  goToConfiguration,
  openCreateRouteDialog,
  settleCreateRoute,
} from "../fixtures/ingress/create-route";
import {
  chooseOption,
  dialogComboboxInputs,
  dialogSelects,
} from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { exportScreen } from "../harness";

let dialog: HTMLElement;

it("ingress-routes-new-2-pages", async () => {
  await exportScreen({
    id: "ingress-routes-new-2-pages",
    title: "Create Route · Pages",
    group: "Ingress",
    route: "/routes/new",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    height: 1100,
    before: expandRouteFolders,
    ready: async () => {
      dialog = await openCreateRouteDialog();
    },
    interact: async (user) => {
      await goToConfiguration(user, dialog, { domains: ["www.example.com"] });
      await chooseOption(user, dialogSelects(dialog)[0], "Pages");
      await user.click(dialogComboboxInputs(dialog)[0]);
      await user.click(await screen.findByRole("button", { name: /^marketing-site/ }));
      await user.click(dialogComboboxInputs(dialog)[1]);
      await user.click(await screen.findByRole("button", { name: /^production/ }));
      await settleCreateRoute(dialog);
    },
    notes: [
      "Step 2 with a Pages target: www.example.com serves the marketing-site production tag.",
    ],
  });
});
