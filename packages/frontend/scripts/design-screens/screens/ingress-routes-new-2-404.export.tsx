import {
  enableSsl,
  goToConfiguration,
  openCreateRouteDialog,
  settleCreateRoute,
} from "../fixtures/ingress/create-route";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { exportScreen } from "../harness";

let dialog: HTMLElement;

it("ingress-routes-new-2-404", async () => {
  await exportScreen({
    id: "ingress-routes-new-2-404",
    title: "Create Route · 404",
    group: "Ingress",
    route: "/routes/new",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: expandRouteFolders,
    ready: async () => {
      dialog = await openCreateRouteDialog();
    },
    interact: async (user) => {
      await goToConfiguration(user, dialog, {
        type: "404",
        domains: ["old-admin.example.com"],
      });
      await enableSsl(user, dialog, /^\*\.example\.com/);
      await settleCreateRoute(dialog);
    },
    notes: ["Step 2 of a 404 route, which blocks a retired hostname: only TLS is configured."],
  });
});
