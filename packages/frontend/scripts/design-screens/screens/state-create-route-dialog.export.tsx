import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { exportScreen } from "../harness";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";

it("state-create-route-dialog", async () => {
  await exportScreen({
    id: "state-create-route-dialog",
    title: "Create Route dialog",
    group: "States",
    // The Add Route entrypoint: the list page with the dialog opened on arrival.
    route: "/routes/new",
    handlers: routeHandlers(),
    before: expandRouteFolders,
    ready: async () => {
      await screen.findByText("legacy-admin.example.com");
      await screen.findByRole("dialog", { name: "Create Route" });
      await waitForReveal();
    },
    notes: ["Step 1 of the Create Route dialog, freshly opened over the routes list."],
  });
});
