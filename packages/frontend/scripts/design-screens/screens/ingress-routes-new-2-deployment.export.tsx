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

it("ingress-routes-new-2-deployment", async () => {
  await exportScreen({
    id: "ingress-routes-new-2-deployment",
    title: "Create Route · Docker deployment",
    group: "Ingress",
    route: "/routes/new",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    height: 1100,
    before: expandRouteFolders,
    ready: async () => {
      dialog = await openCreateRouteDialog();
    },
    interact: async (user) => {
      await goToConfiguration(user, dialog, { domains: ["api-v2.example.com"] });
      await chooseOption(user, dialogSelects(dialog)[0], "Docker deployment");
      await user.click(dialogComboboxInputs(dialog)[0]);
      await user.click(await screen.findByRole("button", { name: /^api/ }));
      await settleCreateRoute(dialog);
    },
    notes: [
      "Step 2 with a blue/green Docker deployment target: api-v2.example.com → the api deployment on Apps 1 over Secure Link.",
    ],
  });
});
