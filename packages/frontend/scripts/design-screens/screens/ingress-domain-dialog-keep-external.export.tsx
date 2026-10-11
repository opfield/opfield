import { screen, within } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { domainDetailHandlers } from "../fixtures/ingress/domain-detail";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-keep-external", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-keep-external",
    title: "Domain · Keep External DNS?",
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
      const resolve = await settleDialog("Resolve Cloudflare DNS Conflict");
      await user.click(within(resolve).getByRole("button", { name: /^Keep external DNS/ }));
      await settleDialog("Keep External DNS?");
    },
    notes: ["Confirmation before automatic Cloudflare migration stops for this hostname."],
  });
});
