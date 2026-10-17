import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { prewarmHandlers } from "../fixtures/docker/prewarm";
import { fillField } from "../fixtures/docker/ready";
import { nodesListHandlers } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-dialog-add-connector", async () => {
  await exportScreen({
    id: "nodes-dialog-add-connector",
    title: "Add hosting connector dialog",
    group: "Nodes",
    route: "/nodes",
    handlers: [...nodesListHandlers(), ...prewarmHandlers()],
    ready: async () => {
      await screen.findAllByText("Edge Amsterdam");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("tab", { name: "Providers" }));
      await user.click(await screen.findByRole("button", { name: /^Add connector$/i }));
      const dialog = await screen.findByRole("dialog");
      await waitForReveal();
      await user.click(within(dialog).getByPlaceholderText("Select..."));
      await user.click(await screen.findByRole("button", { name: "Proxmox VE" }));
      await fillField(user, dialog, "Production hosting", "Branch office");
      await fillField(
        user,
        dialog,
        "https://pve.example.com:8006",
        "https://pve-branch.example.com:8006"
      );
      await fillField(user, dialog, "opfield@pve!hosting", "opfield@pve!provisioning");
      await releaseAnimatedHeights(dialog);
    },
    notes: ["Step 1 of connecting a second Proxmox VE cluster from the Providers tab."],
  });
});
