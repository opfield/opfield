import { screen } from "@testing-library/react";
import { http } from "msw";
import { routeHandlers } from "../fixtures/routes/handlers";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

it("ingress-routes-empty", async () => {
  await exportScreen({
    id: "ingress-routes-empty",
    title: "Routes · Empty",
    group: "Ingress",
    route: "/routes",
    handlers: [
      http.get("*/api/proxy-host-folders/grouped", () =>
        wrapped({ folders: [], ungroupedHosts: [], totalHosts: 0 })
      ),
      http.get("*/api/proxy-host-folders", () => wrapped([])),
      ...routeHandlers(),
    ],
    ready: async () => {
      await screen.findByText("No routes.");
    },
    notes: ["A fresh installation: no routes and no folders yet."],
  });
});
