import { Minus, Plus } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface LabelsSectionProps {
  canEdit: boolean;
  labels: Array<{ key: string; value: string }>;
  setLabels: React.Dispatch<React.SetStateAction<Array<{ key: string; value: string }>>>;
  labelsChanged: boolean;
  inputCell: string;
  description?: string | null;
  action?: React.ReactNode;
}

export function LabelsSection({
  canEdit,
  labels,
  setLabels,
  labelsChanged,
  inputCell,
  description = "Requires container recreation",
  action,
}: LabelsSectionProps) {
  const addLabel = () => setLabels((l) => [...l, { key: "", value: "" }]);
  const removeLabel = (i: number) => setLabels((l) => l.filter((_, idx) => idx !== i));
  const updateLabel = (i: number, field: "key" | "value", val: string) =>
    setLabels((l) => l.map((entry, idx) => (idx === i ? { ...entry, [field]: val } : entry)));

  return (
    <PanelShell
      title={
        <SettingsHelpTitle
          label="Labels"
          help="Docker metadata used by automation, discovery, routing, and management tools. Changing labels recreates the container."
        />
      }
      description={description}
      dirty={labelsChanged}
      actions={
        <>
          {action}
          {canEdit && (
            <Button onClick={addLabel}>
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          )}
        </>
      }
    >
      {labels.length > 0 ? (
        <>
          <div className="grid grid-cols-[1fr_1fr] border-b border-border bg-header text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <div className="px-3 py-2">Key</div>
            <div className="px-3 py-2 border-l border-border">Value</div>
          </div>
          <div>
            {labels.map((l, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_1fr] border-b border-border last:border-b-0"
              >
                <Input
                  className={inputCell}
                  value={l.key}
                  onChange={(e) => updateLabel(i, "key", e.target.value)}
                  placeholder="com.example.key"
                  disabled={!canEdit}
                />
                <div className="flex items-center border-l border-border">
                  <Input
                    className={`${inputCell} flex-1 min-w-0`}
                    value={l.value}
                    onChange={(e) => updateLabel(i, "value", e.target.value)}
                    placeholder="value"
                    disabled={!canEdit}
                  />
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove label"
                      title="Remove label"
                      className="shrink-0 rounded-none border-l border-border"
                      onClick={() => removeLabel(i)}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <EmptyState message="No labels" embedded />
      )}
    </PanelShell>
  );
}
