import { screen } from "@testing-library/react";
import { availabilityHandlers } from "../fixtures/data/availability";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { exportScreen } from "../harness";

it("data-availability-manual", async () => {
  await exportScreen({
    id: "data-availability-manual",
    title: "Database · Availability · Manual mode",
    group: "Data",
    route: "/databases/orders-db/availability",
    height: 1500,
    handlers: [...availabilityHandlers("manual"), ...ordersDetailHandlers()],
    before: installOrdersStreams,
    ready: async () => {
      await screen.findByText("Manual failover");
    },
    notes: ["Two servers and no witness host: manual failover, relay policy lease 72 h (Set to 7 days)."],
  });
});
