import { screen } from "@testing-library/react";
import { availabilityHandlers } from "../fixtures/data/availability";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { exportScreen } from "../harness";

it("data-availability-make-primary-dialog", async () => {
  await exportScreen({
    id: "data-availability-make-primary-dialog",
    title: "Database · Availability · Make this copy primary (lossy)",
    group: "Data",
    route: "/databases/orders-db/availability",
    height: 1100,
    handlers: [...availabilityHandlers("degraded"), ...ordersDetailHandlers()],
    before: installOrdersStreams,
    ready: async () => {
      await screen.findByText("No automatic failover right now");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Actions for Database host 2" }));
      await user.click(await screen.findByRole("menuitem", { name: /Make this copy primary/ }));
      await screen.findByText("Writes may be lost");
    },
    notes: ["The copy is behind and not confirming: the switch may lose writes; typing the name confirms."],
  });
});
