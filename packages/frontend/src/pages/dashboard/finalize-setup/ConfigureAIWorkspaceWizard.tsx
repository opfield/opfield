import { useEffect, useState } from "react";
import { useDialogPresence } from "@/components/ui/dialog";
import {
  type AssistantSetupDraft,
  AssistantSetupWizard,
  EMPTY_ASSISTANT_SETUP_DRAFT,
} from "./AssistantSetupWizard";
import { InferenceSetupWizard } from "./InferenceSetupWizard";

export function ConfigureAIWorkspaceWizard({
  open,
  onBack,
  onConfigured,
  onSkipped,
  allowGatewayInference = true,
  initialStepCanSkip = true,
  completionActionLabel,
  canManageInferenceCore,
}: {
  open: boolean;
  onBack: () => void;
  onConfigured: (configuredVia: "direct" | "gateway_inference") => Promise<void>;
  onSkipped: () => Promise<void>;
  allowGatewayInference?: boolean;
  initialStepCanSkip?: boolean;
  completionActionLabel?: string;
  canManageInferenceCore?: boolean;
}) {
  const [draft, setDraft] = useState<AssistantSetupDraft>(EMPTY_ASSISTANT_SETUP_DRAFT);
  const [screen, setScreen] = useState<"workspace" | "inference">("workspace");

  const present = useDialogPresence(open);
  useEffect(() => {
    if (!present) {
      setDraft(EMPTY_ASSISTANT_SETUP_DRAFT);
      setScreen("workspace");
    }
  }, [present]);

  return (
    <>
      <AssistantSetupWizard
        open={open && screen === "workspace"}
        draft={draft}
        onDraftChange={setDraft}
        onBack={onBack}
        onConfigured={() =>
          onConfigured(draft.source === "inference" ? "gateway_inference" : "direct")
        }
        onSkipped={onSkipped}
        onNeedInference={() => setScreen("inference")}
        allowGatewayInference={allowGatewayInference}
        initialStepCanSkip={initialStepCanSkip}
        completionActionLabel={completionActionLabel}
      />
      <InferenceSetupWizard
        open={open && screen === "inference"}
        canManageCoreOverride={canManageInferenceCore}
        onBack={() => setScreen("workspace")}
        onConfigured={() => onConfigured("gateway_inference")}
        onSkipped={async () => setScreen("workspace")}
        completionActionLabel={completionActionLabel}
      />
    </>
  );
}
