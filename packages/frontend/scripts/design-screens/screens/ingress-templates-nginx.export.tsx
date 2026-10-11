import { screen } from "@testing-library/react";
import {
  nginxTemplateHandlers,
  prepareNginxTemplateList,
} from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-templates-nginx", async () => {
  await exportScreen({
    id: "ingress-templates-nginx",
    title: "Templates · Nginx Config",
    group: "Ingress",
    route: "/routes/templates",
    before: prepareNginxTemplateList,
    handlers: [...nginxTemplateHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Long-poll API");
      await screen.findByText("Maintenance redirect");
    },
    notes: [
      "Three built-in templates in the read-only Built-in folder; six custom proxy and redirect templates in two folders plus ungrouped.",
      "Folder management and drag and drop need proxy:templates:folders:manage (backend work); the fixture operator holds it.",
    ],
  });
});
