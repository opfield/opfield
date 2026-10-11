import { screen, within } from "@testing-library/react";
import { expandFolders } from "../fixtures/data/folders";
import { DOMAIN_FOLDER_STAGING, domainsHandlers } from "../fixtures/edge/domains";
import { domainDetailHandlers, pendingDnsCheckHandlers } from "../fixtures/ingress/domain-detail";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-details-checking", async () => {
  await exportScreen({
    id: "ingress-domain-details-checking",
    title: "Domain · Details (checking DNS)",
    group: "Ingress",
    route: "/routes/domains",
    height: 1000,
    handlers: [
      ...pendingDnsCheckHandlers(),
      ...domainDetailHandlers(),
      ...domainsHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    before: () => expandFolders("domain", [DOMAIN_FOLDER_STAGING]),
    ready: async () => {
      await screen.findByText("staging.app.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByText("staging.app.example.com"));
      const dialog = await settleDialog("staging.app.example.com");
      await within(dialog).findByText("Checking DNS records…");
    },
    notes: [
      "Opening the details runs the DNS check once; POST /api/domains/:id/check-dns is held open, so the section shows it running.",
    ],
  });
});
