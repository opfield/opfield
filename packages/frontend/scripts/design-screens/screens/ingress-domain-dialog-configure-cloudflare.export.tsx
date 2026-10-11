import { screen } from "@testing-library/react";
import { http } from "msw";
import { domainsHandlers } from "../fixtures/edge/domains";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-configure-cloudflare", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-configure-cloudflare",
    title: "Domain · Configure Cloudflare DNS",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [
      // No Cloudflare connector is set up yet.
      http.get("*/api/integrations/cloudflare/connectors", () => wrapped([])),
      ...domainsHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add Domain" }));
      await settleDialog("Configure Cloudflare DNS");
    },
    notes: [
      "Add Domain without a Cloudflare connector: set one up, or continue with external DNS.",
    ],
  });
});
