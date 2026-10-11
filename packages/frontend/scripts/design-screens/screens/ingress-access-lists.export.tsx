import { screen } from "@testing-library/react";
import { accessListHandlers } from "../fixtures/ingress/access-lists";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-access-lists", async () => {
  await exportScreen({
    id: "ingress-access-lists",
    title: "Access Lists",
    group: "Ingress",
    route: "/routes/access-lists",
    handlers: [...accessListHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Support portal");
    },
    notes: ["IP allow/deny lists and basic-auth lists; two are not attached to any route yet."],
  });
});
