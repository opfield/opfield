import { screen, within } from "@testing-library/react";
import {
  enableSsl,
  goToConfiguration,
  openCreateRouteDialog,
  settleCreateRoute,
} from "../fixtures/ingress/create-route";
import { chooseOption, dialogSelects } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { exportScreen } from "../harness";

let dialog: HTMLElement;

it("ingress-routes-new-2-manual", async () => {
  await exportScreen({
    id: "ingress-routes-new-2-manual",
    title: "Create Route · Manual address",
    group: "Ingress",
    route: "/routes/new",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    height: 1100,
    before: expandRouteFolders,
    ready: async () => {
      dialog = await openCreateRouteDialog();
    },
    interact: async (user) => {
      await goToConfiguration(user, dialog, { domains: ["reports.example.com"] });
      await chooseOption(user, dialogSelects(dialog)[0], "Manual address");
      await user.type(within(dialog).getByPlaceholderText("192.168.1.100"), "192.0.2.52");
      const port = within(dialog).getByRole("spinbutton");
      await user.clear(port);
      await user.type(port, "8443");
      await chooseOption(user, dialogSelects(dialog)[1], "HTTPS");
      await enableSsl(user, dialog, /^\*\.example\.com/);
      await screen.findByDisplayValue("192.0.2.52");
      await settleCreateRoute(dialog);
    },
    notes: [
      "Step 2 with a manual upstream: reports.example.com → https://192.0.2.52:8443, TLS with the wildcard certificate.",
    ],
  });
});
