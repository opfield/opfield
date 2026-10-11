import { screen, within } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { domainDetailHandlers, startDocsMigration } from "../fixtures/ingress/domain-detail";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-ingress-migration-waiting-dns", async () => {
  await exportScreen({
    id: "ingress-domain-ingress-migration-waiting-dns",
    title: "Domain · Move Ingress (waiting for DNS)",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [...domainDetailHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    before: startDocsMigration,
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "docs.example.org", "Domain actions", "Complete migration");
      const dialog = await settleDialog("Move Ingress");
      await within(dialog).findByText("External DNS");
    },
    notes: [
      "docs.example.org is moving to Frankfurt; its external DNS must point at the Frankfurt edge before the move completes.",
    ],
  });
});
