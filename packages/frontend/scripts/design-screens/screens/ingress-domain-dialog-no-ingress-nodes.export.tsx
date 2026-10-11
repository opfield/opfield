import { screen } from "@testing-library/react";
import { http } from "msw";
import { domainsHandlers } from "../fixtures/edge/domains";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-no-ingress-nodes", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-no-ingress-nodes",
    title: "Domain · No Ingress Nodes",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [
      http.get("*/api/domains/nginx-nodes", () =>
        wrapped({
          eligibleNodes: [],
          unconfiguredNodes: [],
          totalNginxNodes: 0,
          unconfiguredNginxNodes: 0,
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
      await settleDialog("No Ingress Nodes");
    },
    notes: ["A fresh installation without any connected Ingress node cannot place a domain."],
  });
});
