import { screen } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { domainDetailHandlers } from "../fixtures/ingress/domain-detail";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-details-external", async () => {
  await exportScreen({
    id: "ingress-domain-details-external",
    title: "Domain · Details (external DNS)",
    group: "Ingress",
    route: "/routes/domains",
    height: 1000,
    handlers: [...domainDetailHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getAllByText("legacy-admin.example.com")[0]);
      await settleDialog("legacy-admin.example.com");
      await screen.findByText("Resolve conflict");
    },
    notes: [
      "legacy-admin.example.com on external DNS still resolves to the retired host; automatic Cloudflare migration stopped on a record conflict.",
    ],
  });
});
