import { screen, within } from "@testing-library/react";
import { settleDialog } from "../fixtures/certs/creation";
import { pkiHandlers, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-ca-intermediate-parent", async () => {
  await exportScreen({
    id: "certs-dialog-ca-intermediate-parent",
    title: "Create Intermediate CA · Choose parent",
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
      await settleDialog(dialog);
      await user.click(within(dialog).getAllByRole("combobox")[0]);
      await screen.findByRole("option", { name: "Northwind Partner Root CA" });
    },
    notes: [
      "Create Intermediate from the CA list first asks for the parent: the list offers the active CAs the operator may sign under.",
    ],
  });
});
