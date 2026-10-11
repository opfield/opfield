import {
  fillEntrypoint,
  openCreateRouteDialog,
  settleCreateRoute,
} from "../fixtures/ingress/create-route";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { exportScreen } from "../harness";

let dialog: HTMLElement;

it("ingress-routes-new-1-entrypoint", async () => {
  await exportScreen({
    id: "ingress-routes-new-1-entrypoint",
    title: "Create Route · Entrypoint",
    group: "Ingress",
    route: "/routes/new",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: expandRouteFolders,
    ready: async () => {
      dialog = await openCreateRouteDialog();
    },
    interact: async (user) => {
      await fillEntrypoint(user, dialog, {
        domains: ["billing.example.com", "pay.example.com"],
        folder: "Production",
      });
      await settleCreateRoute(dialog);
    },
    notes: [
      "Step 1 filled in: a proxy route on the Frankfurt edge in the Production folder with two domains.",
    ],
  });
});
