import { screen } from "@testing-library/react";
import { availabilityHandlers } from "../fixtures/data/availability";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { exportScreen } from "../harness";

it("data-availability-healthy", async () => {
  await exportScreen({
    id: "data-availability-healthy",
    title: "Database · Availability · Healthy pair",
    group: "Data",
    route: "/databases/orders-db/availability",
    height: 1500,
    handlers: [...availabilityHandlers("healthy"), ...ordersDetailHandlers()],
    before: installOrdersStreams,
    ready: async () => {
      await screen.findByText("2 servers · automatic failover");
    },
    notes: ["Postgres on two servers with a relay witness, synchronous, near (3.1 ms)."],
  });
});
