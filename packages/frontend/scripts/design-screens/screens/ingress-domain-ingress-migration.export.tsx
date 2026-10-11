import { screen, within } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { domainDetailHandlers } from "../fixtures/ingress/domain-detail";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-ingress-migration", async () => {
  await exportScreen({
    id: "ingress-domain-ingress-migration",
    title: "Domain · Move Ingress",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [...domainDetailHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "app.example.com", "Domain actions", "Move ingress");
      const dialog = await settleDialog("Move Ingress");
      await within(dialog).findByText("Impact");
    },
    notes: [
      "Moving app.example.com from the Frankfurt to the Amsterdam edge; Cloudflare DNS follows automatically.",
    ],
  });
});
