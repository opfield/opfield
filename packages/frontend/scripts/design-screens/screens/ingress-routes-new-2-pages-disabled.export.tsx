import { http } from "msw";
import { goToConfiguration, openCreateRouteDialog } from "../fixtures/ingress/create-route";
import { chooseOption, dialogSelects, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { uiBootstrap } from "../fixtures/shell";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

let dialog: HTMLElement;

it("ingress-routes-new-2-pages-disabled", async () => {
  await exportScreen({
    id: "ingress-routes-new-2-pages-disabled",
    title: "Create Route · Pages disabled",
    group: "Ingress",
    route: "/routes/new",
    handlers: [
      // The Pages feature is switched off in Settings → Features.
      http.get("*/api/ui/bootstrap", () =>
        wrapped({ ...uiBootstrap, navigation: { ...uiBootstrap.navigation, pagesEnabled: false } })
      ),
      ...routeHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    before: expandRouteFolders,
    ready: async () => {
      dialog = await openCreateRouteDialog();
    },
    interact: async (user) => {
      await goToConfiguration(user, dialog, { domains: ["www.example.com"] });
      await chooseOption(user, dialogSelects(dialog)[0], "Pages");
      await settleDialog("Pages Is Disabled");
    },
    notes: ["Choosing the Pages target while the Pages feature is off opens this notice."],
  });
});
