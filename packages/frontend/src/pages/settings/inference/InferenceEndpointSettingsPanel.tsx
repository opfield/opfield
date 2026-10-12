import { useEffect, useRef, useState } from "react";
import { CopyValueField } from "@/components/common/CopyValueField";
import { Notice, NoticeAction } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/services/api";
import type { InferenceClientModel } from "@/services/api-inference";
import type { InferenceToken } from "@/types/inference";

/** Where to get the harness the setup dialog recommends. */
const DEEPSEEK_HARNESS_URL = "https://www.deepseek.com/en/harness/";

/** OpenAI-compatible clients take this as the base URL. */
function openAiBaseUrl() {
  return `${window.location.origin}/api/inference/v1`;
}

/** Anthropic-compatible clients add /v1/messages to this base URL themselves. */
function anthropicBaseUrl() {
  return `${window.location.origin}/api/inference`;
}

export function InferenceEndpointRow() {
  return (
    <SettingsControlRow
      title="Base URL"
      description="Root URL for the OpenAI-compatible inference API used by clients."
      help="Use this address as the provider base URL in OpenAI-compatible clients. Authentication still uses an Opfield inference API token."
    >
      <CopyValueField
        label="Base URL"
        showLabel={false}
        value={openAiBaseUrl()}
        className="w-full"
      />
    </SettingsControlRow>
  );
}

export function InferenceEndpointSettingsPanel() {
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  return (
    <>
      <PanelShell>
        <SettingsControlRow
          title="Inference endpoints"
          description={
            <>
              Connect OpenAI- or Anthropic-compatible tools directly.{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => setInstructionsOpen(true)}
              >
                Set up a harness
              </button>
            </>
          }
        >
          <CopyValueField
            label="Base URL"
            showLabel={false}
            value={openAiBaseUrl()}
            className="w-full"
          />
        </SettingsControlRow>
      </PanelShell>
      <InferenceHarnessDialog open={instructionsOpen} onOpenChange={setInstructionsOpen} />
    </>
  );
}

type HarnessKey =
  | { status: "creating" }
  | { status: "created"; token: string }
  | { status: "failed"; message: string };

type HarnessModels =
  | { status: "loading" }
  | { status: "loaded"; models: InferenceClientModel[] }
  | { status: "failed"; message: string };

/** Names of the tokens this dialog creates; the token API has no other mark for them. */
const HARNESS_TOKEN_PREFIX = "Harness — ";

function harnessTokenName() {
  const created = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());
  return `${HARNESS_TOKEN_PREFIX}${created}`;
}

/** A token an earlier opening of this dialog created that no harness has used. */
function isUnusedHarnessToken(token: InferenceToken) {
  if (token.status !== "active" || !token.name.startsWith(HARNESS_TOKEN_PREFIX)) return false;
  return !token.lastUsedAt;
}

/** Revokes the unused tokens of earlier openings, so they do not pile up. Best effort. */
async function revokeUnusedHarnessTokens() {
  try {
    const tokens = await api.listInferenceTokens();
    await Promise.allSettled(
      tokens.filter(isUnusedHarnessToken).map((token) => api.revokeInferenceToken(token.id))
    );
  } catch {
    // Listing failed: the new token is still created; old ones wait for the next opening.
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Values for setting up any harness in its own provider settings. Opening it revokes the unused
 * tokens of earlier openings, creates a new inference token for the API key, shown once, and
 * lists the models that token can call.
 */
export function InferenceHarnessDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [key, setKey] = useState<HarnessKey>({ status: "creating" });
  const [models, setModels] = useState<HarnessModels>({ status: "loading" });
  const [model, setModel] = useState("");
  // One token per opening, also under StrictMode's repeated effects; results of an earlier
  // opening are dropped.
  const session = useRef(0);
  const started = useRef(false);

  useEffect(() => {
    if (!open) {
      started.current = false;
      return;
    }
    if (started.current) return;
    started.current = true;
    const current = ++session.current;
    setKey({ status: "creating" });
    setModels({ status: "loading" });
    setModel("");
    void (async () => {
      await revokeUnusedHarnessTokens();
      let token: string;
      try {
        token = (await api.createInferenceToken(harnessTokenName())).token;
      } catch (error) {
        if (session.current !== current) return;
        const message = errorMessage(error, "The inference token could not be created.");
        setKey({ status: "failed", message });
        setModels({ status: "failed", message });
        return;
      }
      if (session.current !== current) return;
      setKey({ status: "created", token });
      try {
        const list = await api.listInferenceCatalog();
        if (session.current !== current) return;
        setModels({ status: "loaded", models: list });
        setModel(list[0]?.id ?? "");
      } catch (error) {
        if (session.current !== current) return;
        setModels({
          status: "failed",
          message: errorMessage(error, "Models could not be loaded."),
        });
      }
    })();
  }, [open]);

  const modelList = models.status === "loaded" ? models.models : [];
  const modelPlaceholder = models.status === "loading" ? "Loading models…" : "No models available";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Set Up an Inference Harness</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Connect any harness or tool that takes an OpenAI- or Anthropic-compatible provider.
        </DialogDescription>

        <div className="min-w-0 space-y-4">
          <div className="min-w-0 space-y-3">
            <CopyValueField label="OpenAI-compatible base URL" value={openAiBaseUrl()} />
            <div className="min-w-0 space-y-1.5">
              <CopyValueField label="Anthropic-compatible base URL" value={anthropicBaseUrl()} />
              <p className="text-xs text-muted-foreground">
                Anthropic clients add /v1/messages to it themselves.
              </p>
            </div>
            {key.status === "failed" ? (
              <Notice tone="warning" title="API key not created">
                {key.message} Create an inference token on your profile and use it as the API key.
              </Notice>
            ) : (
              <div className="min-w-0 space-y-1.5">
                <CopyValueField
                  label="API key"
                  value={key.status === "created" ? key.token : "Creating…"}
                  copyable={key.status === "created"}
                />
                <p className="text-xs text-muted-foreground">
                  A new inference token for this harness. Copy it now: it is not shown again.
                </p>
              </div>
            )}
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="inference-harness-model" className="text-sm font-medium">
                Model
              </label>
              <Select value={model} onValueChange={setModel} disabled={modelList.length === 0}>
                <SelectTrigger id="inference-harness-model" aria-label="Model">
                  <SelectValue placeholder={modelPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {modelList.map((item) => (
                    <SelectItem
                      key={item.id}
                      value={item.id}
                      description={
                        item.display_name && item.display_name !== item.id
                          ? item.display_name
                          : undefined
                      }
                    >
                      {item.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {models.status === "failed" && key.status === "created"
                  ? models.message
                  : "Any model your account can use."}
              </p>
            </div>
          </div>
          <Notice
            tone="info"
            title="Recommended: DeepSeek harness"
            actions={
              <NoticeAction tone="info" href={DEEPSEEK_HARNESS_URL}>
                Get DeepSeek harness
              </NoticeAction>
            }
          >
            Paste these values into its provider settings.
          </Notice>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
