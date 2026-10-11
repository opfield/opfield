import { screen } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { domainDetailHandlers } from "../fixtures/ingress/domain-detail";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-details", async () => {
  await exportScreen({
    id: "ingress-domain-details",
    title: "Domain · Details",
    group: "Ingress",
    route: "/routes/domains",
    height: 1000,
    handlers: [...domainDetailHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getAllByText("app.example.com")[0]);
      await settleDialog("app.example.com");
      await screen.findByText("Usage");
    },
    notes: [
      "app.example.com: Cloudflare-managed A record on the Frankfurt edge, used by one route and two certificates.",
    ],
  });
});
