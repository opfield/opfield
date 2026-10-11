import { screen } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-delete-mapping", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-delete-mapping",
    title: "Domain · Delete Domain Mapping",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "grafana.example.com", "Domain actions", "Delete");
      await settleDialog("Delete Domain Mapping");
    },
    notes: [
      "grafana.example.com was matched to an existing Cloudflare record, so removing it keeps that record.",
    ],
  });
});
