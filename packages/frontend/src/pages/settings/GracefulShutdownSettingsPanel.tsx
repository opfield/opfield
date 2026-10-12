import { Power, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { NumericInput } from "@/components/ui/numeric-input";
import { toastApiError } from "@/lib/api-error-toast";
import type { AuthProvisioningSettings } from "@/types";

type ShutdownSettings = AuthProvisioningSettings["generalSettings"]["shutdown"];

interface GracefulShutdownSettingsPanelProps {
  value: ShutdownSettings;
  canEdit: boolean;
  hidden?: boolean;
  onSave: (value: ShutdownSettings) => Promise<ShutdownSettings>;
}

function toRaw(value: ShutdownSettings) {
  return {
    userRequestDrainSeconds: String(value.userRequestDrainSeconds),
    structuredLogDrainSeconds: String(value.structuredLogDrainSeconds),
    finalizationTimeoutSeconds: String(value.finalizationTimeoutSeconds),
  };
}

export function GracefulShutdownSettingsPanel({
  value,
  canEdit,
  hidden,
  onSave,
}: GracefulShutdownSettingsPanelProps) {
  const [draft, setDraft] = useState(value);
  const [raw, setRaw] = useState(() => toRaw(value));
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setDraft(value);
    setRaw(toRaw(value));
  }, [value]);

  const totalSeconds =
    draft.userRequestDrainSeconds +
    draft.structuredLogDrainSeconds +
    draft.finalizationTimeoutSeconds;
  const isValid =
    /^\d+$/.test(raw.userRequestDrainSeconds.trim()) &&
    /^\d+$/.test(raw.structuredLogDrainSeconds.trim()) &&
    /^\d+$/.test(raw.finalizationTimeoutSeconds.trim()) &&
    Number.isInteger(draft.userRequestDrainSeconds) &&
    draft.userRequestDrainSeconds >= 0 &&
    draft.userRequestDrainSeconds <= 40 &&
    Number.isInteger(draft.structuredLogDrainSeconds) &&
    draft.structuredLogDrainSeconds >= 0 &&
    draft.structuredLogDrainSeconds <= 10 &&
    Number.isInteger(draft.finalizationTimeoutSeconds) &&
    draft.finalizationTimeoutSeconds >= 5 &&
    draft.finalizationTimeoutSeconds <= 15 &&
    totalSeconds <= 50;
  const hasChanges =
    draft.userRequestDrainSeconds !== value.userRequestDrainSeconds ||
    draft.structuredLogDrainSeconds !== value.structuredLogDrainSeconds ||
    draft.finalizationTimeoutSeconds !== value.finalizationTimeoutSeconds;

  const save = async () => {
    if (!canEdit || !isValid || !hasChanges) return;
    setIsSaving(true);
    try {
      const saved = await onSave(draft);
      setDraft(saved);
      setRaw(toRaw(saved));
      toast.success("Graceful shutdown settings updated");
    } catch (error) {
      toastApiError(error, "Failed to update graceful shutdown settings");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <PanelShell
      hidden={hidden}
      title="Graceful shutdown"
      description="Controls how long Opfield drains user traffic, structured logs, and final cleanup before restart"
      icon={<Power className="h-4 w-4" />}
      actions={
        <Button
          aria-label="Save graceful shutdown settings"
          onClick={save}
          pending={isSaving}
          disabled={!canEdit || !hasChanges || !isValid}
        >
          <Save className="h-4 w-4" />
          Save
        </Button>
      }
      dirty={hasChanges}
    >
      <div className="divide-y divide-border">
        <SettingsControlRow
          title="User request drain"
          description="Time in seconds for requests and short jobs already in progress to finish. New user requests are rejected immediately."
          help="When Opfield begins shutting down, it stops accepting new user work but waits up to this long for requests and short-running jobs that already started."
        >
          <div className="w-full sm:w-40">
            <NumericInput
              aria-label="User request drain in seconds"
              value={draft.userRequestDrainSeconds}
              min={0}
              max={40}
              step={1}
              disabled={!canEdit || isSaving}
              onChange={(value, rawValue) => {
                setDraft((current) => ({ ...current, userRequestDrainSeconds: value }));
                setRaw((current) => ({ ...current, userRequestDrainSeconds: rawValue }));
              }}
            />
          </div>
        </SettingsControlRow>
        <SettingsControlRow
          title="Structured log drain"
          description="Additional time in seconds for accepted log batches to reach storage after user traffic has drained."
          help="After user traffic finishes draining, Opfield reserves this additional period for accepted structured-log batches to be written to storage."
        >
          <div className="w-full sm:w-40">
            <NumericInput
              aria-label="Structured log drain in seconds"
              value={draft.structuredLogDrainSeconds}
              min={0}
              max={10}
              step={1}
              disabled={!canEdit || isSaving}
              onChange={(value, rawValue) => {
                setDraft((current) => ({ ...current, structuredLogDrainSeconds: value }));
                setRaw((current) => ({ ...current, structuredLogDrainSeconds: rawValue }));
              }}
            />
          </div>
        </SettingsControlRow>
        <SettingsControlRow
          title="Finalization timeout"
          description="Time in seconds reserved for closing transports, workers, and dependency clients."
          help="Final cleanup window for closing WebSockets, background workers, database clients, and other runtime resources before the process exits."
        >
          <div className="w-full sm:w-40">
            <NumericInput
              aria-label="Finalization timeout in seconds"
              value={draft.finalizationTimeoutSeconds}
              min={5}
              max={15}
              step={1}
              disabled={!canEdit || isSaving}
              onChange={(value, rawValue) => {
                setDraft((current) => ({
                  ...current,
                  finalizationTimeoutSeconds: value,
                }));
                setRaw((current) => ({ ...current, finalizationTimeoutSeconds: rawValue }));
              }}
            />
          </div>
        </SettingsControlRow>
        <SettingsControlRow
          title="Total hard deadline"
          description={
            totalSeconds > 50
              ? "The combined deadline must not exceed 50 seconds."
              : "Docker keeps an additional safety margin before forcing the container to stop."
          }
          help="The three shutdown phases share a maximum 50-second budget. Docker keeps an additional margin before it forcibly terminates the container."
        >
          <span
            className={
              totalSeconds > 50 ? "text-sm font-medium text-destructive" : "text-sm font-medium"
            }
          >
            {totalSeconds} seconds
          </span>
        </SettingsControlRow>
      </div>
    </PanelShell>
  );
}
