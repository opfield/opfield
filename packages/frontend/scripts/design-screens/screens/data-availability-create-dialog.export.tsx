import { screen, within } from "@testing-library/react";
import { availabilityHandlers } from "../fixtures/data/availability";
import { databaseHandlers } from "../fixtures/data/database-handlers";
import { databaseFolders } from "../fixtures/data/databases";
import { expandFolders } from "../fixtures/data/folders";
import { exportScreen } from "../harness";

it("data-availability-create-dialog", async () => {
  await exportScreen({
    id: "data-availability-create-dialog",
    title: "Databases · Deploy · Availability step",
    group: "Data",
    route: "/databases",
    handlers: [...availabilityHandlers("single"), ...databaseHandlers()],
    height: 1300,
    before: () => {
      expandFolders(
        "database",
        databaseFolders.map((folder) => folder.id)
      );
    },
    ready: async () => {
      await screen.findByText("events-warehouse");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Deploy database" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getAllByRole("textbox")[0], "inventory-db");
      const nodePicker = within(dialog)
        .getAllByRole("combobox")
        .find((element) => element.textContent?.includes("Select node"));
      if (nodePicker) {
        await user.click(nodePicker);
        await user.click(await screen.findByRole("option", { name: "Database host" }));
      }
      const serversPicker = within(dialog)
        .getAllByRole("combobox")
        .find((element) => element.textContent?.includes("Single server"));
      if (serversPicker) {
        await user.click(serversPicker);
        await user.click(await screen.findByRole("option", { name: /Two or more servers/ }));
      }
      await user.click(within(dialog).getByRole("button", { name: /Next/ }));
      await user.click(await within(dialog).findByRole("button", { name: /Next/ }));
      await user.click(await within(dialog).findByRole("checkbox", { name: "Database host 2" }));
      await screen.findByText("Near servers · 3.1 ms round trip", undefined, { timeout: 4000 });
    },
    notes: [
      "Last step of the managed database wizard with Two or more servers: servers, witness, durability, live preflight.",
      "Relay policy lease 72 h: the preflight offers Set to 7 days.",
    ],
  });
});
