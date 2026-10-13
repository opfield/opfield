import { GitBranch, ListChecks, Pencil, Plus, Shield, X } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import type { AccessLineView } from "./use-access-editor";

interface AccessPanelProps {
  views: readonly AccessLineView[];
  description: string;
  /** The folders and names the lines need are still loading: the enclosing dialog waits. */
  loading?: boolean;
  /** Without these the list is read-only. */
  onAdd?: () => void;
  onEdit?: (index: number) => void;
  onRemove?: (index: number) => void;
}

/**
 * The access list of a group, a user or a token (and of an OAuth request, read-only): one row
 * per line, with its role and place over what it covers. Lines from a group only show.
 */
export function AccessPanel({
  views,
  description,
  loading = false,
  onAdd,
  onEdit,
  onRemove,
}: AccessPanelProps) {
  useContentLoading(loading);
  return (
    <PanelShell
      title="Access"
      description={description}
      actions={
        onAdd ? (
          <Button type="button" onClick={onAdd}>
            <Plus className="h-4 w-4" />
            Add Access
          </Button>
        ) : undefined
      }
    >
      {views.length === 0 ? (
        <EmptyState message="No access yet." embedded />
      ) : (
        <div className="divide-y divide-border">
          {views.map((view) => {
            const Icon =
              view.line.kind === "git"
                ? GitBranch
                : view.line.kind === "custom"
                  ? ListChecks
                  : Shield;
            const editable = view.index !== undefined && !view.from;
            const from = view.from ? `· from ${view.from}` : null;
            // Long titles and details end in an ellipsis (full text on hover), the group a line
            // comes from stays in view; a row never widens the panel or the dialog around it.
            // Detail and group share the line: a short one shows in full and the other gets the
            // rest; two long ones get half each.
            return (
              <div key={view.key} className="flex items-center justify-between gap-3 p-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={view.title}>
                      {view.title}
                    </p>
                    <p
                      className="grid min-w-0 auto-cols-[minmax(0,auto)] grid-flow-col justify-start gap-1 text-xs text-muted-foreground"
                      title={from ? `${view.detail} ${from}` : view.detail}
                    >
                      <span className="truncate">{view.detail}</span>
                      {from ? <span className="truncate">{from}</span> : null}
                    </p>
                    {view.note ? (
                      <p className="mt-1 text-xs text-warning-foreground">{view.note}</p>
                    ) : null}
                  </div>
                </div>
                {editable && (onEdit || onRemove) ? (
                  <div className="flex shrink-0">
                    {onEdit ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${view.title}`}
                        onClick={() => onEdit(view.index!)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    ) : null}
                    {onRemove ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${view.title}`}
                        onClick={() => onRemove(view.index!)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </PanelShell>
  );
}
