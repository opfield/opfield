import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";

it("ingress-routes", async () => {
  await exportScreen({
    id: "ingress-routes",
    title: "Routes",
    group: "Ingress",
    route: "/routes",
    handlers: routeHandlers(),
    before: expandRouteFolders,
    ready: async () => {
      await screen.findByText("legacy-admin.example.com");
      await screen.findByText("staging.app.example.com");
    },
    notes: [
      "Nine routes in two expanded folders (Production, Internal) plus two ungrouped.",
      "grafana is degraded, legacy-admin offline, staging.app is a disabled redirect.",
    ],
  });
});
