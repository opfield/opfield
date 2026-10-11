import { screen, within } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { addDomainPreviewHandlers } from "../fixtures/ingress/domain-detail";
import { chooseOption, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-dialog-add-domain-overwrite", async () => {
  await exportScreen({
    id: "ingress-dialog-add-domain-overwrite",
    title: "Add Domain · Overwrite Cloudflare DNS",
    group: "Ingress",
    route: "/routes/domains",
    height: 1000,
    handlers: [
      ...addDomainPreviewHandlers("conflict"),
      ...domainsHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add Domain" }));
      const dialog = await settleDialog("Add Domain");
      await user.type(
        within(dialog).getByRole("textbox", { name: "Domain" }),
        "portal.example.com"
      );
      await chooseOption(
        user,
        within(dialog).getByRole("combobox", { name: "Ingress node" }),
        /Edge Frankfurt/
      );
      await within(dialog).findByText("mismatch");
      await user.click(within(dialog).getByRole("button", { name: "Add Domain" }));
      await settleDialog("Overwrite Cloudflare DNS");
    },
    notes: [
      "Adding over the conflicting record: the server answers 409 DOMAIN_DNS_TARGET_MISMATCH and the dialog asks before overwriting.",
    ],
  });
});
