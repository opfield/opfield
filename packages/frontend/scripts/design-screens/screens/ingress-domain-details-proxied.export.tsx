import { screen } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { domainDetailHandlers } from "../fixtures/ingress/domain-detail";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-details-proxied", async () => {
  await exportScreen({
    id: "ingress-domain-details-proxied",
    title: "Domain · Details (Cloudflare proxied)",
    group: "Ingress",
    route: "/routes/domains",
    height: 1000,
    handlers: [...domainDetailHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getAllByText("status.example.com")[0]);
      await settleDialog("status.example.com");
      await screen.findByText("Cloudflare Target");
    },
    notes: [
      "status.example.com behind the Cloudflare proxy: the origin panel shows the Amsterdam edge it targets.",
    ],
  });
});
