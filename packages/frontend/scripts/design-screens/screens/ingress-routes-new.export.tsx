import { screen, waitFor, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";
import { exportScreen } from "../harness";

it("ingress-routes-new", async () => {
  await exportScreen({
    id: "ingress-routes-new",
    title: "Create Route · Configuration",
    group: "Ingress",
    // The Add Route entrypoint; step 1 alone is the States board `state-create-route-dialog`.
    route: "/routes/new",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    height: 1100,
    before: expandRouteFolders,
    ready: async () => {
      await screen.findByText("legacy-admin.example.com");
      await screen.findByRole("dialog", { name: "Create Route" });
      await waitForReveal();
    },
    interact: async (user) => {
      const dialog = screen.getByRole("dialog", { name: "Create Route" });
      await user.click(within(dialog).getByRole("combobox", { name: "Ingress node" }));
      await user.click(await screen.findByRole("option", { name: /Edge Frankfurt/ }));
      const domainInput = within(dialog)
        .getAllByRole("combobox")
        .find((element) => element.tagName === "INPUT")!;
      await user.type(domainInput, "billing.example.com");
      await user.click(within(dialog).getByText("Domain Names"));
      await user.click(within(dialog).getByRole("button", { name: /Next/ }));
      await waitFor(() => expect(within(dialog).queryByText("Domain Names")).toBeNull());
      const [dockerResource] = within(dialog)
        .getAllByRole("combobox")
        .filter((element) => element.tagName === "INPUT");
      await user.click(dockerResource);
      await user.click(await screen.findByRole("button", { name: /^worker/ }));
      await user.type(within(dialog).getByRole("spinbutton"), "8081");
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: [
      "Step 2 of Create Route: billing.example.com on the Frankfurt edge → the worker container on Apps 1.",
    ],
  });
});
