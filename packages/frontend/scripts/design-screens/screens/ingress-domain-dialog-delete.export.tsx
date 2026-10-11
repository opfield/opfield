import { screen } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-delete", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-delete",
    title: "Domain · Delete Domain",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "app.example.com", "Domain actions", "Delete");
      await settleDialog("Delete Domain");
    },
    notes: ["Deleting a Cloudflare-managed domain also removes the DNS records Opfield created."],
  });
});
