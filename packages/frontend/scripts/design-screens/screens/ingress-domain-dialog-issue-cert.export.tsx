import { screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";
import { domainsHandlers } from "../fixtures/edge/domains";
import {
  addBillingDomain,
  domainDetailHandlers,
  sslCertificateFolders,
} from "../fixtures/ingress/domain-detail";
import { chooseOption, chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

/** The operator issues certificates only into two certificate folders, not at the root. */
function grantFolderIssueOnly() {
  useAuthStore.setState((state) => ({
    user: state.user && {
      ...state.user,
      scopes: [
        ...state.user.scopes.filter((scope) => scope !== "ssl:cert:issue"),
        ...sslCertificateFolders.map((folder) => `ssl:cert:issue:folder/${folder.id}`),
      ],
    },
  }));
}

it("ingress-domain-dialog-issue-cert", async () => {
  await exportScreen({
    id: "ingress-domain-dialog-issue-cert",
    title: "Domain · Issue Certificate",
    group: "Ingress",
    route: "/routes/domains",
    handlers: [...domainDetailHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    before: () => {
      addBillingDomain();
      grantFolderIssueOnly();
    },
    ready: async () => {
      await screen.findByText("billing.example.com");
    },
    interact: async (user) => {
      await chooseRowAction(user, "billing.example.com", "Domain actions", "Issue Cert");
      const dialog = await settleDialog("Issue Certificate");
      await chooseOption(
        user,
        dialog.querySelector<HTMLElement>('[aria-label="Certificate folder"]')!,
        "Customer domains"
      );
    },
    notes: [
      "Issue Cert for the new billing.example.com; this operator may issue only into certificate folders, so the dialog asks for one.",
    ],
  });
});
