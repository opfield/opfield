import { within } from "@testing-library/react";
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

it("ingress-routes-new-2-redirect", async () => {
  await exportScreen({
    id: "ingress-routes-new-2-redirect",
    title: "Create Route · Redirect",
    group: "Ingress",
    route: "/routes/new",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    height: 1000,
    before: expandRouteFolders,
    ready: async () => {
      dialog = await openCreateRouteDialog();
    },
    interact: async (user) => {
      await goToConfiguration(user, dialog, {
        type: "Redirect",
        domains: ["shop.example.com"],
      });
      await user.type(
        within(dialog).getByPlaceholderText("https://example.com"),
        "https://shop.example.net"
      );
      await chooseOption(user, dialogSelects(dialog)[0], /^302/);
      await enableSsl(user, dialog, /^\*\.example\.com/);
      await settleCreateRoute(dialog);
    },
    notes: ["Step 2 of a redirect route: shop.example.com → https://shop.example.net (302)."],
  });
});
