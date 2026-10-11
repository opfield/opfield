import { screen, within } from "@testing-library/react";
import { fillCAForm } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-ca-intermediate", async () => {
  await exportScreen({
    id: "certs-dialog-ca-intermediate",
    title: "Create Intermediate CA · Filled",
    group: "Certificates",
    route: "/certificates/authorities",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("Northwind Clients CA");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create Intermediate" }));
      const dialog = await screen.findByRole("dialog", { name: "Create Intermediate CA" });
      await user.click(within(dialog).getAllByRole("combobox")[0]);
      await user.click(await screen.findByRole("option", { name: "Northwind Partner Root CA" }));
      await fillCAForm(user, dialog, {
        commonName: "Partner Gateway CA",
        algorithm: "ECDSA P-256",
        years: "5",
        pathLength: "0",
        maxDays: "397",
      });
    },
    notes: [
      "An intermediate under the partner root: five years, no further CAs below it, leaf certificates up to 397 days.",
    ],
  });
});
