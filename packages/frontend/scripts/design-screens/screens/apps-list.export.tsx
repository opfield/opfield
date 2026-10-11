import { screen } from "@testing-library/react";
import { appsHandlers } from "../fixtures/apps";
import { exportScreen } from "../harness";

it("apps-list", async () => {
  await exportScreen({
    id: "apps-list",
    title: "Apps",
    group: "Overview",
    route: "/apps",
    handlers: appsHandlers(),
    ready: async () => {
      await screen.findByText("billing");
    },
  });
});
