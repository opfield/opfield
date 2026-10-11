import { screen } from "@testing-library/react";
import { http } from "msw";
import { domainNginxNodes, domainsHandlers } from "../fixtures/edge/domains";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-no-public-address", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-no-public-address",
    title: "Domain · No Public Ingress Addresses",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [
      http.get("*/api/domains/nginx-nodes", () =>
        wrapped({
          eligibleNodes: [],
          unconfiguredNodes: domainNginxNodes.eligibleNodes,
          totalNginxNodes: 2,
          unconfiguredNginxNodes: 2,
        })
      ),
      ...domainsHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add Domain" }));
      await settleDialog("No Public Ingress Addresses");
    },
    notes: ["Both edges report only private service addresses, so none can be the DNS target."],
  });
});
