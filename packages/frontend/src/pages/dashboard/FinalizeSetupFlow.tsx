import { useState } from "react";
import { useAuthStore } from "@/stores/auth";
import type { FinalizeSetupState, FinalizeSetupStep } from "@/types";
import { FinalizeSetupDialog, type FinalizeSetupRootStep } from "./FinalizeSetupDialog";
import { ConfigureAIWorkspaceWizard } from "./finalize-setup/ConfigureAIWorkspaceWizard";
import { IntegrationsSetupWizard } from "./finalize-setup/IntegrationsSetupWizard";
import { InviteUsersSetupWizard } from "./finalize-setup/InviteUsersSetupWizard";
import { MfaSetupWizard } from "./finalize-setup/MfaSetupWizard";
import { NodeSetupWizard } from "./finalize-setup/NodeSetupWizard";

/**
 * The established Finalize Setup checklist and its existing wizards, hosted
 * outside the Operations dashboard when a Workspace entry point opens it.
 */
export function FinalizeSetupFlow({
  open,
  state,
  inviteUserMethods,
  onClose,
  onUpdateStep,
}: {
  open: boolean;
  state: FinalizeSetupState;
  inviteUserMethods: { password: boolean; emailOtp: boolean } | null;
  onClose: () => void;
  onUpdateStep: (step: FinalizeSetupStep, status: "configured" | "skipped") => Promise<void>;
}) {
  const user = useAuthStore((store) => store.user);
  const hasScope = useAuthStore((store) => store.hasScope);
  const [activeWizard, setActiveWizard] = useState<FinalizeSetupRootStep | null>(null);
  const [busy, setBusy] = useState(false);

  const completeStep = async (
    step: Exclude<FinalizeSetupRootStep, "integrations">,
    status: "configured" | "skipped"
  ) => {
    setBusy(true);
    try {
      await onUpdateStep(step, status);
      setActiveWizard(null);
    } finally {
      setBusy(false);
    }
  };

  const backToChecklist = () => setActiveWizard(null);

  return (
    <>
      <FinalizeSetupDialog
        open={open && activeWizard === null}
        state={state}
        userId={user?.id ?? ""}
        busy={busy}
        canInviteUsers={inviteUserMethods !== null}
        onOpenWizard={(step) => setActiveWizard(step)}
        onSkipForNow={onClose}
        onFinish={onClose}
      />
      <NodeSetupWizard
        open={open && activeWizard === "nodes"}
        onBack={backToChecklist}
        onConfigured={() => completeStep("nodes", "configured")}
        onSkipped={() => completeStep("nodes", "skipped")}
      />
      {/* close-reset-ok: inviteUserMethods comes from permissions, not cleared on close */}
      {inviteUserMethods && (
        <InviteUsersSetupWizard
          open={open && activeWizard === "invite_users"}
          methods={inviteUserMethods}
          onBack={backToChecklist}
          onConfigured={() => completeStep("invite_users", "configured")}
          onSkipped={() => completeStep("invite_users", "skipped")}
        />
      )}
      <ConfigureAIWorkspaceWizard
        open={open && activeWizard === "ai_workspace"}
        allowGatewayInference={[
          "settings:gateway:edit",
          "inference:providers:view",
          "inference:providers:manage",
          "inference:models:manage",
          "inference:limits:manage",
        ].every(hasScope)}
        onBack={backToChecklist}
        onConfigured={() => completeStep("ai_workspace", "configured")}
        onSkipped={() => completeStep("ai_workspace", "skipped")}
      />
      <IntegrationsSetupWizard
        open={open && activeWizard === "integrations"}
        state={state}
        onBack={backToChecklist}
        onStep={onUpdateStep}
      />
      <MfaSetupWizard
        open={open && activeWizard === "mfa"}
        mode="onboarding"
        onBack={backToChecklist}
        onConfigured={() => completeStep("mfa", "configured")}
        onSkipped={() => completeStep("mfa", "skipped")}
        allowSkip
      />
    </>
  );
}
