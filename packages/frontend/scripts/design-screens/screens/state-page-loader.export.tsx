import { screen } from "@testing-library/react";
import { http } from "msw";
import { exportScreen } from "../harness";
import { domainsHandlers } from "../fixtures/edge/domains";

it("state-page-loader", async () => {
  await exportScreen({
    id: "state-page-loader",
    title: "Page loader",
    group: "States",
    route: "/routes/domains",
    handlers: [
      // The domain list never answers, so the page stays behind its loader.
      http.get("*/api/domains", () => new Promise<never>(() => {})),
      ...domainsHandlers(),
    ],
    captureBeforeReveal: async () => {
      await screen.findByRole("status", { name: "Loading" }, { timeout: 5000 });
    },
    notes: ["Domains page while its list request is still in flight (loader appears after 500 ms)."],
  });
});
