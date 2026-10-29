import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { accessListHandlers } from "../fixtures/ingress/access-lists";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-dialog-access-list", async () => {
  await exportScreen({
    id: "ingress-dialog-access-list",
    title: "Edit Access List dialog",
    group: "Ingress",
    route: "/routes/access-lists",
    handlers: [...accessListHandlers(), ...backgroundPrewarmHandlers()],
    height: 1000,
    ready: async () => {
      await screen.findByText("Support portal");
    },
    interact: async (user) => {
      await user.click(screen.getByText("Support portal"));
      const dialog = await screen.findByRole("dialog", { name: "Edit Access List" });
      await within(dialog).findByDisplayValue("10.0.40.0/24");
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: [
      "Editing an access list with four sign-in methods, three users, an address that skips sign-in and Include / Require / Exclude rules.",
    ],
  });
});
