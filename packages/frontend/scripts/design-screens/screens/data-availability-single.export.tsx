import { screen } from "@testing-library/react";
import { availabilityHandlers } from "../fixtures/data/availability";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { exportScreen } from "../harness";

it("data-availability-single", async () => {
  await exportScreen({
    id: "data-availability-single",
    title: "Database · Availability · One server",
    group: "Data",
    route: "/databases/orders-db/availability",
    height: 700,
    handlers: [...availabilityHandlers("single"), ...ordersDetailHandlers()],
    before: installOrdersStreams,
    ready: async () => {
      await screen.findByText("This database runs on one server.");
    },
    notes: ["A single-server managed Postgres: Make available… in the header and the empty state."],
  });
});
