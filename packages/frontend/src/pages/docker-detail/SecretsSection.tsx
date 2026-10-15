import { Eye, EyeOff, Lock, Minus, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface SecretRow {
  /** DB id — undefined for newly added secrets */
  id?: string;
  key: string;
  value: string;
  /** true when the value has been changed from its original */
  dirty: boolean;
}

interface SecretsSectionProps {
  canManageSecrets: boolean;
  saveButtonLabel?: string;
  /** The Save button's icon: RotateCcw where saving recreates the container. */
  saveIcon?: React.ReactNode;
  onSave?: () => void;
  saveDisabled?: boolean;
  isSaving?: boolean;
  secretRows: SecretRow[];
  setSecretRows: React.Dispatch<React.SetStateAction<SecretRow[]>>;
  setDeletedSecrets: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  duplicateSecretIndices: Set<number>;
  invalidKeyPattern: RegExp;
  hiddenKeys?: Set<string>;
  description?: string;
  /** Unsaved edits: the warning border of a changed block. */
  dirty?: boolean;
  /** New values are masked too, with Show (secrets typed before the container exists). */
  maskNewValues?: boolean;
}

export function SecretsSection({
  canManageSecrets,
  saveButtonLabel,
  saveIcon = <RotateCcw className="h-3.5 w-3.5" />,
  onSave,
  saveDisabled = false,
  isSaving = false,
  secretRows,
  setSecretRows,
  setDeletedSecrets,
  duplicateSecretIndices,
  invalidKeyPattern,
  hiddenKeys = new Set(),
  description,
  dirty = false,
  maskNewValues = false,
}: SecretsSectionProps) {
  const [revealedSecrets, setRevealedSecrets] = useState<Set<number>>(new Set());
  const visibleSecretRows = secretRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !hiddenKeys.has(row.key.trim()));

  const addSecretRow = () =>
    setSecretRows((prev) => [...prev, { key: "", value: "", dirty: true }]);

  const updateSecretRow = (idx: number, field: "key" | "value", val: string) => {
    setSecretRows((prev) => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], [field]: val, dirty: true };
      return updated;
    });
  };

  const removeSecretRow = (idx: number) => {
    const row = secretRows[idx];
    if (row.id) {
      setDeletedSecrets((prev) => new Map(prev).set(row.id!, row.key.trim()));
    }
    setSecretRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const toggleReveal = (idx: number) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <PanelShell
      className="overflow-visible"
      title={
        <span className="flex items-center gap-2">
          <Lock className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Secrets</span>
        </span>
      }
      description={description ?? "Encrypted at rest — injected as env vars on container start"}
      dirty={dirty}
      actions={
        canManageSecrets ? (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={addSecretRow}
              title="Add secret"
              aria-label="Add secret"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            {onSave && (
              <Button variant="warning" onClick={onSave} pending={isSaving} disabled={saveDisabled}>
                {saveIcon}
                {saveButtonLabel ?? "Save"}
              </Button>
            )}
          </div>
        ) : null
      }
    >
      {visibleSecretRows.length > 0 && (
        <div className="grid grid-cols-[1fr_1fr] border-b border-border bg-header text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <div className="px-3 py-2">Key</div>
          <div className="px-3 py-2 border-l border-border">Value</div>
        </div>
      )}

      <div>
        {visibleSecretRows.map(({ row, index: idx }) => {
          const isNew = !row.id;
          const isMasked = row.value === "••••••••";
          const isRevealed = revealedSecrets.has(idx);
          const hasKeyError =
            duplicateSecretIndices.has(idx) ||
            (row.key.trim() && !invalidKeyPattern.test(row.key.trim()));

          return (
            <div
              key={row.id ?? `new-${idx}`}
              className="grid grid-cols-[1fr_1fr] border-b border-border last:border-b-0"
            >
              {canManageSecrets ? (
                <>
                  <Input
                    value={row.key}
                    onChange={(e) => isNew && updateSecretRow(idx, "key", e.target.value)}
                    readOnly={!isNew}
                    className={`h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
                      hasKeyError ? "bg-destructive/10 text-destructive" : ""
                    }`}
                    placeholder="SECRET_KEY"
                  />
                  <div className="flex items-center border-l border-border">
                    <Input
                      type={(isNew && !maskNewValues) || isRevealed ? "text" : "password"}
                      value={isMasked && !row.dirty ? "" : row.value}
                      onChange={(e) => updateSecretRow(idx, "value", e.target.value)}
                      className="h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring flex-1 min-w-0"
                      placeholder={isMasked && !row.dirty ? "••••••••" : "secret value"}
                    />
                    {(!isNew || maskNewValues) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={isRevealed ? "Hide" : "Show"}
                        className="shrink-0 rounded-none border-l border-border"
                        onClick={() => toggleReveal(idx)}
                        title={isRevealed ? "Hide" : "Show"}
                      >
                        {isRevealed ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove secret"
                      title="Remove secret"
                      className="shrink-0 rounded-none border-l border-border"
                      onClick={() => removeSecretRow(idx)}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <span className="px-3 py-2 text-xs md:text-sm font-mono truncate">{row.key}</span>
                  <span className="px-3 py-2 text-xs md:text-sm font-mono text-muted-foreground truncate border-l border-border">
                    ••••••••
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>

      {visibleSecretRows.length === 0 && (
        <EmptyState
          message="No secrets configured."
          actionLabel={canManageSecrets ? "Add one" : undefined}
          onAction={canManageSecrets ? addSecretRow : undefined}
          embedded
        />
      )}
    </PanelShell>
  );
}
