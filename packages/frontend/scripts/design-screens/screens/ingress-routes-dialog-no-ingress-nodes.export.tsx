import { screen } from "@testing-library/react";
import { http } from "msw";
import { settleDialog } from "../fixtures/ingress/interactions";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { ok } from "../handlers";
import { exportScreen } from "../harness";

it("ingress-routes-dialog-no-ingress-nodes", async () => {
  await exportScreen({
    id: "ingress-routes-dialog-no-ingress-nodes",
    title: "Routes · No Ingress Nodes",
    group: "Ingress",
    // Add Route checks for an Ingress node first; this installation has none connected.
    route: "/routes/new",
    handlers: [
      http.get("*/api/nodes", ({ request }) => {
        if (new URL(request.url).searchParams.get("type") !== "nginx") return;
        return ok({ data: [], total: 0, page: 1, limit: 1, totalPages: 1 });
      }),
      ...routeHandlers(),
    ],
    before: expandRouteFolders,
    ready: async () => {
      await screen.findByText("legacy-admin.example.com");
    },
    interact: async () => {
      await settleDialog("No Ingress Nodes");
    },
    notes: ["Add Route before any Ingress node is connected: the dialog points to Nodes."],
  });
});
