import { screen } from "@testing-library/react";
import { fillCAForm } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-ca-root", async () => {
  await exportScreen({
    id: "certs-dialog-ca-root",
    title: "Create Root CA · Filled",
    group: "Certificates",
    route: "/certificates/authorities",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("Northwind Clients CA");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create Root CA" }));
      const dialog = await screen.findByRole("dialog", { name: "Create Root CA" });
      await fillCAForm(user, dialog, {
        commonName: "Northwind Root CA 2026",
        algorithm: "ECDSA P-384",
        years: "20",
        pathLength: "1",
        maxDays: "825",
      });
    },
    notes: ["A new self-signed root CA: ECDSA P-384, 20 years, one intermediate level below it."],
  });
});
