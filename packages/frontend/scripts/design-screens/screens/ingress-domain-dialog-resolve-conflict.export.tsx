import { screen } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { domainDetailHandlers } from "../fixtures/ingress/domain-detail";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-resolve-conflict", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-resolve-conflict",
    title: "Domain · Resolve Cloudflare DNS Conflict",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [...domainDetailHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByText("legacy-admin.example.com"));
      await settleDialog("legacy-admin.example.com");
      await user.click(await screen.findByRole("button", { name: /Resolve conflict/ }));
      await settleDialog("Resolve Cloudflare DNS Conflict");
    },
    notes: [
      "The record points at 198.51.100.87; the fix is to point it at the Frankfurt edge and hand it to Cloudflare, or keep external DNS.",
    ],
  });
});
