import { screen, within } from "@testing-library/react";
import { expandFolders } from "../fixtures/data/folders";
import { DOMAIN_FOLDER_STAGING, domainsHandlers } from "../fixtures/edge/domains";
import { domainDetailHandlers } from "../fixtures/ingress/domain-detail";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-details-dns-checked", async () => {
  await exportScreen({
    id: "ingress-domain-details-dns-checked",
    title: "Domain · Details (first DNS check)",
    group: "Ingress",
    route: "/routes/domains",
    height: 1000,
    handlers: [...domainDetailHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    before: () => expandFolders("domain", [DOMAIN_FOLDER_STAGING]),
    ready: async () => {
      await screen.findByText("staging.app.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByText("staging.app.example.com"));
      const dialog = await settleDialog("staging.app.example.com");
      // Opening the details checks DNS; the never-checked staging hostname now resolves.
      await within(dialog).findByText("CAA");
      await within(dialog).findByText("Last checked");
    },
    notes: [
      "The staging hostname had never been checked; opening it ran the check, which found the Frankfurt edge.",
    ],
  });
});
