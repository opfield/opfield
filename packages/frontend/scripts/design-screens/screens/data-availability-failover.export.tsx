import { screen } from "@testing-library/react";
import { availabilityHandlers } from "../fixtures/data/availability";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { exportScreen } from "../harness";

it("data-availability-failover", async () => {
  await exportScreen({
    id: "data-availability-failover",
    title: "Database · Availability · Failover in progress",
    group: "Data",
    route: "/databases/orders-db/availability",
    height: 1500,
    handlers: [...availabilityHandlers("failover"), ...ordersDetailHandlers()],
    before: installOrdersStreams,
    ready: async () => {
      await screen.findByText("A copy is taking over");
    },
    notes: ["The primary stopped reporting; the copy is taking over."],
  });
});
