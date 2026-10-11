import { screen } from "@testing-library/react";
import { availabilityHandlers } from "../fixtures/data/availability";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { exportScreen } from "../harness";

it("data-availability-degraded", async () => {
  await exportScreen({
    id: "data-availability-degraded",
    title: "Database · Availability · Degraded",
    group: "Data",
    route: "/databases/orders-db/availability",
    height: 1500,
    handlers: [...availabilityHandlers("degraded"), ...ordersDetailHandlers()],
    before: installOrdersStreams,
    ready: async () => {
      await screen.findByText("No automatic failover right now");
    },
    notes: ["The copy stopped confirming writes: no automatic failover until it catches up."],
  });
});
