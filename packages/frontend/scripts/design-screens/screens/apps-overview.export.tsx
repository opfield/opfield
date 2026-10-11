import { screen } from "@testing-library/react";
import { appsHandlers } from "../fixtures/apps";
import { exportScreen } from "../harness";

it("apps-overview", async () => {
  await exportScreen({
    id: "apps-overview",
    title: "Apps · shop · Overview",
    group: "Overview",
    route: "/apps/shop",
    height: 1500,
    handlers: appsHandlers(),
    ready: async () => {
      await screen.findByText("Staging", undefined, { timeout: 10_000 });
    },
    notes: ["The shop app with Production and Staging; Staging has one restarting container."],
  });
});
