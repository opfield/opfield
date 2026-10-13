import { Bot, Cpu, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChoiceCard } from "@/components/common/ChoiceCard";
import { Notice, NoticeAction } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { useDialogPresence } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import type { InferenceLimitInput } from "@/types/inference";
import { FinalizeSetupCompletion } from "./FinalizeSetupCompletion";
import { FinalizeSetupWizardDialog } from "./FinalizeSetupWizardDialog";

export interface AssistantSetupDraft {
  source: "external" | "inference" | null;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const EMPTY_ASSISTANT_SETUP_DRAFT: AssistantSetupDraft = {
  source: null,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
};

const AI_WORKSPACE_DEFAULT_LIMITS: InferenceLimitInput = {
  enabled: true,
  credits5hEnabled: false,
  credits5h: 0,
  credits7dEnabled: false,
  credits7d: 0,
  credits30dEnabled: false,
  credits30d: 0,
  apiMonthlyMicrodollars: 0,
  billingTimezone: "UTC",
};

type InferenceModelOption = { id: string; displayName: string };

function readInferenceModels(config: Record<string, unknown>): InferenceModelOption[] {
  const value = config.opfieldInferenceModels;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { id?: unknown; displayName?: unknown };
    return typeof candidate.id === "string"
      ? [
          {
            id: candidate.id,
            displayName:
              typeof candidate.displayName === "string" ? candidate.displayName : candidate.id,
          },
        ]
      : [];
  });
}

export function AssistantSetupWizard({
  open,
  draft,
  onDraftChange,
  onBack,
  onConfigured,
  onSkipped,
  onNeedInference,
  allowOpfieldInference = true,
  initialStepCanSkip = true,
  completionActionLabel = "Back to checklist",
}: {
  open: boolean;
  draft: AssistantSetupDraft;
  onDraftChange: (draft: AssistantSetupDraft) => void;
  onBack: () => void;
  onConfigured: () => Promise<void>;
  onSkipped: () => Promise<void>;
  onNeedInference: () => void;
  allowOpfieldInference?: boolean;
  initialStepCanSkip?: boolean;
  completionActionLabel?: string;
}) {
  const [inferenceModels, setInferenceModels] = useState<InferenceModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completed, setCompleted] = useState(false);

  const present = useDialogPresence(open);
  // Reset once the close animation has played, so the closing dialog keeps its content.
  useEffect(() => {
    if (!present) setCompleted(false);
  }, [present]);

  // Load the models once per choice of Opfield Inference: picking a model
  // changes the draft and must not reload the list under the open Select.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  useEffect(() => {
    if (!open || draft.source !== "inference") return;
    let active = true;
    setLoadingModels(true);
    api
      .getAIConfig()
      .then((config) => {
        if (!active) return;
        const models = readInferenceModels(config);
        setInferenceModels(models);
        const current = draftRef.current;
        if (!current.model && models[0])
          onDraftChangeRef.current({ ...current, model: models[0].id });
      })
      .catch((cause) => {
        if (active) {
          toastApiError(cause, "Failed to load inference models");
        }
      })
      .finally(() => {
        if (active) setLoadingModels(false);
      });
    return () => {
      active = false;
    };
  }, [draft.source, open]);

  const save = async () => {
    if (!draft.source) return;
    if (
      (draft.source === "external" &&
        (!draft.baseUrl.trim() || !draft.apiKey.trim() || !draft.model.trim())) ||
      (draft.source === "inference" && !draft.model)
    )
      return;
    setSaving(true);
    try {
      if (draft.source === "inference") {
        const policies = await api.listInferenceLimits();
        if (!policies.some((policy) => policy.policyType === "default")) {
          await api.setInferenceDefaultLimits(AI_WORKSPACE_DEFAULT_LIMITS);
        }
      }
      await api.updateAIConfig(
        draft.source === "external"
          ? {
              enabled: true,
              providerType: "openai_compatible",
              providerUrl: draft.baseUrl.trim(),
              apiKey: draft.apiKey,
              model: draft.model.trim(),
            }
          : {
              enabled: true,
              providerType: "opfield_inference",
              opfieldInferenceModel: draft.model,
              opfieldInferenceAllowUserModelSelection: true,
            }
      );
      await useAIStore.getState().refreshProviderStatus();
      setCompleted(true);
    } catch (cause) {
      toastApiError(cause, "Failed to configure AI Workspace");
    } finally {
      setSaving(false);
    }
  };

  const setSource = (source: AssistantSetupDraft["source"]) => {
    onDraftChange({ ...draft, source, model: source === "inference" ? draft.model : "" });
  };

  const screen = completed ? "complete" : (draft.source ?? "choice");
  return (
    <FinalizeSetupWizardDialog
      open={open}
      title="Configure AI Workspace"
      description={
        <>
          <p>
            AI Workspace is Opfield's intent-driven operations interface. Describe the outcome you
            want, keep the operational context in one Work Session, and move between guidance and
            Opfield resources without losing your place.
          </p>
          <p>
            Choose an OAI-compatible provider when you already have an OpenAI-compatible endpoint,
            API key, and model that should serve this Opfield installation. Opfield stores that
            connection for AI Workspace only; it does not expose the provider as a shared model
            catalog.
          </p>
          {allowOpfieldInference && (
            <p>
              Choose Opfield Inference when providers and models should be managed centrally for
              multiple users or features. It requires Inference to have a connected provider and at
              least one enabled model first. You can revise either choice later in Settings.
            </p>
          )}
          <p>
            AI Workspace is recommended, not required. Operations Console keeps every Opfield
            capability available without a model connection.
          </p>
        </>
      }
      stepKey={screen}
      onBack={completed ? undefined : draft.source ? () => setSource(null) : onBack}
      onSkip={completed || (!initialStepCanSkip && draft.source === null) ? undefined : onSkipped}
      skipDisabled={saving}
      footer={
        completed ? (
          <Button onClick={() => void onConfigured()} disabled={saving}>
            <Bot /> {completionActionLabel}
          </Button>
        ) : draft.source ? (
          <Button
            onClick={() => void save()}
            pending={saving}
            disabled={
              !draft.model ||
              (draft.source === "external" && (!draft.baseUrl.trim() || !draft.apiKey.trim()))
            }
          >
            <Bot />
            Save AI Workspace
          </Button>
        ) : null
      }
    >
      {completed ? (
        <FinalizeSetupCompletion
          title="AI Workspace configured"
          continueIn="Continue from Settings → AI Workspace to change its model connection whenever your requirements change."
        >
          Opfield can now use the selected Workspace model while preserving each operator's
          permissions.
        </FinalizeSetupCompletion>
      ) : draft.source === null ? (
        <div className="space-y-3">
          <ChoiceCard
            icon={ExternalLink}
            title="OAI-compatible provider"
            description="Connect OpenAI or any compatible endpoint with your own API key and model."
            onClick={() => setSource("external")}
          />
          {allowOpfieldInference && (
            <ChoiceCard
              icon={Cpu}
              title="Opfield Inference"
              description="Use centrally managed providers and models that Opfield makes available."
              onClick={() => setSource("inference")}
            />
          )}
        </div>
      ) : draft.source === "external" ? (
        <PanelShell
          title="OAI-compatible provider"
          description="Connect the model provider used only by AI Workspace."
        >
          <SettingsControlRow
            title="Base URL"
            description="The provider's OpenAI-compatible API endpoint."
            controlsClassName="sm:min-w-[18rem]"
          >
            <Input
              value={draft.baseUrl}
              onChange={(event) => onDraftChange({ ...draft, baseUrl: event.target.value })}
              placeholder="https://api.openai.com/v1"
              autoFocus
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="API key"
            description="Stored encrypted and used only for AI Workspace requests."
            controlsClassName="sm:min-w-[18rem]"
          >
            <Input
              type="password"
              value={draft.apiKey}
              onChange={(event) => onDraftChange({ ...draft, apiKey: event.target.value })}
              autoComplete="off"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Model"
            description="The Workspace model name sent with each request."
            controlsClassName="sm:min-w-[18rem]"
          >
            <Input
              value={draft.model}
              onChange={(event) => onDraftChange({ ...draft, model: event.target.value })}
              placeholder="gpt-4.1-mini"
            />
          </SettingsControlRow>
        </PanelShell>
      ) : loadingModels ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 animate-spin" /> Checking Opfield Inference…
        </div>
      ) : inferenceModels.length === 0 ? (
        <Notice
          tone="warning"
          title="Opfield Inference needs setup"
          actions={
            <NoticeAction tone="warning" onClick={onNeedInference}>
              Configure Opfield Inference
            </NoticeAction>
          }
        >
          Connect a provider and make at least one model available before AI Workspace can use
          Opfield Inference.
        </Notice>
      ) : (
        <PanelShell
          title="Opfield Inference"
          description="Centrally managed models available to AI Workspace."
        >
          <SettingsControlRow
            title="Default model"
            description="Model used when a Work Session starts. Operators can switch to another allowed model."
            controlsClassName="sm:min-w-[18rem]"
          >
            <Select
              value={draft.model}
              onValueChange={(model) => onDraftChange({ ...draft, model })}
            >
              <SelectTrigger aria-label="Default model" className="text-sm">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {inferenceModels.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsControlRow>
        </PanelShell>
      )}
    </FinalizeSetupWizardDialog>
  );
}
