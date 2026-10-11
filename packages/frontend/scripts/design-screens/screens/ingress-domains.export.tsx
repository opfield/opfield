import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { domainsHandlers } from "../fixtures/edge/domains";

it("ingress-domains", async () => {
  await exportScreen({
    id: "ingress-domains",
    title: "Domains",
    group: "Ingress",
    route: "/routes/domains",
    handlers: domainsHandlers(),
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
  });
});
