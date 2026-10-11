import { screen } from "@testing-library/react";
import { domainsHandlers } from "../fixtures/edge/domains";
import { addBillingDomain, domainDetailHandlers } from "../fixtures/ingress/domain-detail";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-domain-dialog-create-route", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-create-route",
    title: "Domain · Create Route",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [...domainDetailHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    before: addBillingDomain,
    ready: async () => {
      await screen.findByText("billing.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "billing.example.com", "Domain actions", "Create route");
      await settleDialog("Create Route");
      await screen.findByDisplayValue("billing.example.com");
    },
    notes: [
      "Create route from a domain: the Create Route dialog opens with the domain and its Ingress node filled in.",
    ],
  });
});
