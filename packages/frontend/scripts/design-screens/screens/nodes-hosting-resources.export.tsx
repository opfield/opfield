import { screen } from "@testing-library/react";
import { labCluster } from "../fixtures/nodes/hosting";
import { nodesListHandlers } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-hosting-resources", async () => {
  await exportScreen({
    id: "nodes-hosting-resources",
    title: "Hosting integration · Virtual machines",
    group: "Nodes",
    route: `/hosting/${labCluster.id}/resources`,
    handlers: nodesListHandlers(),
    height: 1100,
    ready: async () => {
      await screen.findByText("win-build-test");
    },
    notes: ["Two guests are discovered but have no Opfield daemon yet (Unbound)."],
  });
});
