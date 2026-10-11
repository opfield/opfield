import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { settleDialog } from "../fixtures/ingress/interactions";
import { nginxTemplateStateHandlers } from "../fixtures/ingress/nginx-template-states";
import {
  nginxTemplateHandlers,
  prepareNginxTemplateList,
} from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-templates-nginx-dialog-preview", async () => {
  await exportScreen({
    id: "ingress-templates-nginx-dialog-preview",
    title: "Templates · Nginx Config · Built-in preview",
    group: "Ingress",
    route: "/routes/templates",
    before: prepareNginxTemplateList,
    handlers: [
      ...nginxTemplateStateHandlers(),
      ...nginxTemplateHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    ready: async () => {
      await screen.findByText("Long-poll API");
    },
    interact: async (user) => {
      // Built-in templates are read-only: opening one shows its rendered preview.
      await user.click(screen.getByText("Default Proxy"));
      await settleDialog("Default Proxy");
      markEditors();
    },
    placeholders: [
      { selector: EDITOR_SELECTOR, label: "Rendered Nginx config (CodeMirror, read-only)" },
    ],
    notes: ["The built-in Default Proxy template rendered with sample data."],
  });
});
