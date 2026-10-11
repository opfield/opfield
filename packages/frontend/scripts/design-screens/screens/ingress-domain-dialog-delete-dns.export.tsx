import { screen, within } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { adoptedDomainDeleteHandlers, domainByName } from "../fixtures/ingress/domain-detail";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-delete-dns", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-delete-dns",
    title: "Domain · Delete Cloudflare DNS Too?",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [
      ...adoptedDomainDeleteHandlers(),
      ...domainsHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    before: () => {
      // Gateway took over the existing Cloudflare records of the status page.
      domainByName("status.example.com").dnsOwnership = "overwritten";
    },
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "status.example.com", "Domain actions", "Delete");
      const confirm = await settleDialog("Delete Domain");
      await user.click(within(confirm).getByRole("button", { name: "Delete" }));
      await settleDialog("Delete Cloudflare DNS Too?");
    },
    notes: [
      "Deleting a domain whose records were adopted from Cloudflare: the server asks whether those records go too.",
    ],
  });
});
