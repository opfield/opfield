import { screen, waitFor, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { exportScreen } from "../harness";
import { routeHandlers } from "../fixtures/routes/handlers";
import { expandRouteFolders } from "../fixtures/routes/state";

/** The switch in a settings row, found by the row's title. */
function rowSwitch(title: string) {
  const row = screen.getByText(title, { exact: true }).parentElement?.parentElement;
  if (!row) throw new Error(`settings row "${title}" not found`);
  return within(row).getByRole("button");
}

it("state-button-pending", async () => {
  await exportScreen({
    id: "state-button-pending",
    title: "Button · pending",
    group: "States",
    route: "/routes/new",
    // POST /api/proxy-hosts never answers, so Create stays pending.
    handlers: routeHandlers({ createRoute: () => new Promise<Response>(() => {}) }),
    before: expandRouteFolders,
    ready: async () => {
      await screen.findByText("legacy-admin.example.com");
      await screen.findByRole("dialog", { name: "Create Route" });
      await waitForReveal();
    },
    interact: async (user) => {
      const dialog = screen.getByRole("dialog", { name: "Create Route" });

      // Step 1: ingress node, folder and a registered domain.
      await user.click(within(dialog).getByRole("combobox", { name: "Ingress node" }));
      await user.click(await screen.findByRole("option", { name: /Edge Frankfurt/ }));
      await user.click(within(dialog).getByRole("combobox", { name: "Folder" }));
      await user.click(await screen.findByRole("option", { name: "Production" }));
      await user.type(within(dialog).getByPlaceholderText("example.com"), "beta.example.com");
      await user.click(await screen.findByRole("button", { name: /^beta\.example\.com/ }));
      await user.click(within(dialog).getByRole("button", { name: /next/i }));

      // Step 2: the web container on Apps 1, WebSocket, TLS with the wildcard certificate.
      await screen.findByText("Docker Resource");
      const resource = within(dialog)
        .getAllByRole("combobox")
        .find((element) => element.getAttribute("placeholder") === "Select a resource...");
      if (!resource) throw new Error("Docker resource combobox not found");
      await user.click(resource);
      await user.type(resource, "web");
      await user.click(await screen.findByRole("button", { name: /^web/ }));
      await waitFor(() => expect(within(dialog).getByPlaceholderText("8080")).toHaveValue(3000));

      await user.click(rowSwitch("WebSocket Support"));
      await user.click(rowSwitch("SSL Enabled"));
      await user.click(rowSwitch("Force HTTPS"));
      await user.click(rowSwitch("HTTP/2"));
      const certificate = within(dialog).getByRole("combobox", { name: "SSL Certificate" });
      await user.click(certificate);
      await user.type(certificate, "*.example.com");
      await user.click(await screen.findByRole("button", { name: /\*\.example\.com \(acme\)/ }));

      const create = within(dialog).getByRole("button", { name: /^create$/i });
      await waitFor(() => expect(create).toBeEnabled());
      await user.click(create);
      await waitFor(() => expect(create).toHaveAttribute("aria-busy", "true"));
      await waitForReveal();
    },
    notes: [
      "Create Route step 2 filled in (beta.example.com → web:3000 on Apps 1, TLS with *.example.com).",
      "Create was pressed and POST /api/proxy-hosts is held open, so the button shows its spinner.",
    ],
  });
});
