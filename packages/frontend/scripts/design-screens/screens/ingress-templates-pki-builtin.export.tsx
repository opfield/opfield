import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-templates-pki-builtin", async () => {
  await exportScreen({
    id: "ingress-templates-pki-builtin",
    title: "Templates · PKI built-in template",
    group: "Ingress",
    route: "/certificates/templates",
    before: preparePkiLists,
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("TLS Server");
    },
    interact: async (user) => {
      await user.click(screen.getByText("TLS Server"));
      const dialog = await screen.findByRole("dialog", { name: "TLS Server" });
      await user.click(within(dialog).getByRole("button", { name: "Next" }));
      await within(dialog).findAllByRole("checkbox");
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: [
      "A built-in template opens the template wizard read-only: every step can be viewed, the fields are disabled and there is no Save.",
      "Shown on the Key Usage step of the built-in TLS Server template.",
    ],
  });
});
