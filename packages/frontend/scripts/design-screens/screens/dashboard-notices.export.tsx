import { screen } from "@testing-library/react";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { exportScreen } from "../harness";
import { appsNode, edgeNode } from "../fixtures/nodes";
import { dashboardNoticeHandlers } from "../fixtures/overview/dashboard-notices";

it("dashboard-notices", async () => {
  await exportScreen({
    id: "dashboard-notices",
    title: "Dashboard · Notices",
    group: "Overview",
    route: "/",
    handlers: dashboardNoticeHandlers,
    healthBarsWidth: 180,
    before: () => {
      usePinnedNodesStore.setState({ dashboardNodeIds: [edgeNode.id, appsNode.id] });
    },
    ready: async () => {
      await screen.findByText("Opfield license has expired");
      await screen.findByText("Opfield relay recovery in progress");
      await screen.findByText("2 managed TLS certificates need attention");
    },
    notes: [
      "The canonical notice: license grace period, relay recovery and managed TLS certificates that do not renew.",
    ],
  });
});
