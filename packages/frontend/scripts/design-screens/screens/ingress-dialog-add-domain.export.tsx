import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { domainsHandlers } from "../fixtures/edge/domains";
import { domainPreviewHandlers } from "../fixtures/ingress/domains";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-dialog-add-domain", async () => {
  await exportScreen({
    id: "ingress-dialog-add-domain",
    title: "Add Domain dialog",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [...domainPreviewHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add Domain" }));
      const dialog = await screen.findByRole("dialog", { name: "Add Domain" });
      await user.type(
        within(dialog).getByRole("textbox", { name: "Domain" }),
        "billing.example.com"
      );
      await user.click(within(dialog).getByRole("combobox", { name: "Ingress node" }));
      await user.click(await screen.findByRole("option", { name: /Edge Frankfurt/ }));
      await user.type(
        within(dialog).getByRole("textbox", { name: "Description" }),
        "Invoices and payment portal"
      );
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: ["Adding billing.example.com with Cloudflare-managed DNS."],
  });
});
