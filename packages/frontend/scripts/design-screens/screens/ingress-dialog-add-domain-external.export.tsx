import { screen, within } from "@testing-library/react";
import { http } from "msw";
import { domainsHandlers } from "../fixtures/edge/domains";
import { addDomainPreviewHandlers } from "../fixtures/ingress/domain-detail";
import { chooseOption, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

it("ingress-dialog-add-domain-external", async () => {
  await exportScreen({
    id: "ingress-dialog-add-domain-external",
    title: "Add Domain · External DNS",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [
      // Without a Cloudflare connector the operator continues with external DNS.
      http.get("*/api/integrations/cloudflare/connectors", () => wrapped([])),
      ...addDomainPreviewHandlers("external"),
      ...domainsHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add Domain" }));
      const choice = await settleDialog("Configure Cloudflare DNS");
      await user.click(within(choice).getByRole("button", { name: "Continue without Cloudflare" }));
      const dialog = await settleDialog("Add Domain");
      await user.type(
        within(dialog).getByRole("textbox", { name: "Domain" }),
        "portal.example.org"
      );
      await chooseOption(
        user,
        within(dialog).getByRole("combobox", { name: "Ingress node" }),
        /Edge Frankfurt/
      );
      await within(dialog).findByText("DNS check");
      await within(dialog).findByText("198.51.100.87");
      await settleDialog("Add Domain");
    },
    notes: [
      "External DNS: portal.example.org still resolves to 198.51.100.87, so Check DNS and Add stays disabled until it points at the Frankfurt edge.",
    ],
  });
});
