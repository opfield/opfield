import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { domainsHandlers } from "../fixtures/edge/domains";
import { sslHandlers } from "../fixtures/edge/ssl";

it("certs-ssl-certificates", async () => {
  await exportScreen({
    id: "certs-ssl-certificates",
    title: "SSL certificates",
    group: "Certificates",
    route: "/certificates",
    handlers: [...sslHandlers(), ...domainsHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com", { selector: "p.font-medium" });
    },
  });
});
