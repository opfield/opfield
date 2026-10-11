import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { connectRepositoryHandlers, pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-source-connect-step-2", async () => {
  await exportScreen({
    id: "ingress-pages-project-source-connect-step-2",
    title: "Pages project · Source · Connect repository (2 of 2)",
    group: "Ingress",
    route: "/pages/partner-portal/source",
    handlers: pagesProjectHandlers(...connectRepositoryHandlers()),
    ready: async () => {
      await screen.findByText(/No repository connected/);
    },
    interact: async (user) => {
      // The panel header and the empty state both offer it; use the header button.
      await user.click(screen.getAllByRole("button", { name: "Connect repository" })[0]);
      const dialog = await screen.findByRole("dialog", { name: "Connect Repository" });
      await user.click(within(dialog).getByPlaceholderText("Select Git integration"));
      await user.click(await screen.findByRole("button", { name: "Northwind GitLab" }));
      await user.click(within(dialog).getByPlaceholderText("Select allowlisted repository"));
      await user.click(await screen.findByRole("button", { name: "northwind/partner-portal" }));
      await user.click(within(dialog).getByRole("button", { name: /Continue/ }));
      await within(dialog).findByText("Artifact directory");
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: [
      "Step 2 after Opfield read package.json from the branch: pnpm 9.12.0 detected, the build script, output folder and the Tag each build publishes.",
    ],
  });
});
