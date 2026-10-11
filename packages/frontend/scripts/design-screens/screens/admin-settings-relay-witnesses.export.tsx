import { http } from "msw";
import { witnessRelaySnapshot } from "../fixtures/data/availability";
import { waitForPageText } from "../fixtures/data/ready";
import { settingsTabHandlers } from "../fixtures/ops/handlers";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

it("admin-settings-relay-witnesses", async () => {
  await exportScreen({
    id: "admin-settings-relay-witnesses",
    title: "Settings · Relay · Witness hosting",
    group: "Administration",
    route: "/settings/relay",
    handlers: [
      http.get("*/api/system/relay", () => wrapped(witnessRelaySnapshot)),
      ...settingsTabHandlers(),
    ],
    height: 1400,
    ready: async () => {
      await waitForPageText("partner-relay", "Protected relay: needs local opt-in");
    },
    notes: [
      "Witnesses column: the remote relay hosts orders-db's voter; a protected relay needs its owner's local opt-in.",
    ],
  });
});
