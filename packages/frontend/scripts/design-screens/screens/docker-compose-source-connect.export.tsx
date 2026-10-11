import { screen } from "@testing-library/react";
import { http } from "msw";
import { wrapped } from "../handlers";
import { composeIds } from "../fixtures/docker/data";
import { composeProjectHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-compose-source-connect", async () => {
  await exportScreen({
    id: "docker-compose-source-connect",
    title: "Compose project · Source · Not connected",
    group: "Docker",
    route: `/docker/compose/${composeIds.stack}/source`,
    handlers: [
      // The same project deployed from Gateway-stored YAML only.
      http.get("*/api/docker/nodes/:nodeId/compose-projects/:projectId/source", () =>
        wrapped(null)
      ),
      ...composeProjectHandlers(),
    ],
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText(/No repository connected/);
    },
    notes: [
      "A Compose project deployed from Opfield-stored YAML; the Source tab offers to connect a Git repository.",
    ],
  });
});
