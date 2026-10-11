import { Minus, Plus } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SqlTableMetadata } from "@/types";
import {
  createNewColumnDraft,
  currentColumnTypeValue,
  type NewColumnDraft,
  POSTGRES_COLUMN_TYPE_OPTIONS,
  secondaryColumnTypeLabel,
} from "./postgres-explorer-state";

export function PostgresColumnSchemaDialog({
  open,
  onOpenChange,
  metadata,
  canChangeColumnTypes,
  currentTableType,
  columnTypeDrafts,
  setColumnTypeDrafts,
  newColumnDrafts,
  setNewColumnDrafts,
  deletedColumnNames,
  setDeletedColumnNames,
  invalidNewColumnIds,
  changingColumn,
  schemaChangeCount,
  canSaveColumnSchemaChanges,
  onReset,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metadata: SqlTableMetadata | null;
  canChangeColumnTypes: boolean;
  currentTableType: string | undefined;
  columnTypeDrafts: Record<string, string>;
  setColumnTypeDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  newColumnDrafts: NewColumnDraft[];
  setNewColumnDrafts: Dispatch<SetStateAction<NewColumnDraft[]>>;
  deletedColumnNames: string[];
  setDeletedColumnNames: Dispatch<SetStateAction<string[]>>;
  invalidNewColumnIds: Set<string>;
  changingColumn: string | null;
  schemaChangeCount: number;
  canSaveColumnSchemaChanges: boolean;
  onReset: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Column Types</DialogTitle>
        </DialogHeader>
        {metadata ? (
          <PanelShell
            title="Columns"
            description={`${metadata.namespace}.${metadata.table}`}
            headerActionsClassName="pl-4"
            actions={
              canChangeColumnTypes ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setNewColumnDrafts((prev) => [...prev, createNewColumnDraft()])}
                  disabled={changingColumn !== null}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add column
                </Button>
              ) : null
            }
            bodyClassName="overflow-x-auto"
          >
            {metadata.columns.length + newColumnDrafts.length > 0 ? (
              <>
                {metadata.columns.map((column) => {
                  const currentType = currentColumnTypeValue(column);
                  const markedDeleted = deletedColumnNames.includes(column.name);
                  const secondaryTypeLabel = secondaryColumnTypeLabel(column);
                  const typeOptions = POSTGRES_COLUMN_TYPE_OPTIONS.includes(currentType)
                    ? POSTGRES_COLUMN_TYPE_OPTIONS
                    : [currentType, ...POSTGRES_COLUMN_TYPE_OPTIONS];
                  return (
                    <div
                      key={column.name}
                      className={`grid ${
                        canChangeColumnTypes
                          ? "grid-cols-[minmax(0,1fr)_220px_36px]"
                          : "grid-cols-[minmax(0,1fr)_220px]"
                      } border-b border-border last:border-b-0 ${markedDeleted ? "bg-destructive/10 opacity-70" : ""}`}
                    >
                      <div className="flex h-9 min-w-0 items-center gap-2 px-3">
                        <span className={`truncate text-sm ${markedDeleted ? "line-through" : ""}`}>
                          {column.name}
                        </span>
                        {column.isPrimaryKey && (
                          <Badge variant="secondary" size="inline">
                            PK
                          </Badge>
                        )}
                        <span className="ml-auto truncate text-xs text-muted-foreground">
                          {secondaryTypeLabel}
                        </span>
                      </div>
                      <div className="border-l border-border">
                        <Select
                          value={columnTypeDrafts[column.name] ?? currentType}
                          onValueChange={(nextType) =>
                            setColumnTypeDrafts((prev) => ({ ...prev, [column.name]: nextType }))
                          }
                          disabled={
                            !canChangeColumnTypes || changingColumn !== null || markedDeleted
                          }
                        >
                          <SelectTrigger
                            aria-label={`Data type of ${column.name}`}
                            className="h-9 rounded-none border-0 shadow-none focus:ring-1 focus:ring-inset"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {typeOptions.map((type) => (
                              <SelectItem key={type} value={type}>
                                {type}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {canChangeColumnTypes && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="rounded-none border-l border-border"
                          onClick={() =>
                            setDeletedColumnNames((prev) =>
                              prev.includes(column.name)
                                ? prev.filter((name) => name !== column.name)
                                : [...prev, column.name]
                            )
                          }
                          title={markedDeleted ? "Undo column removal" : "Remove column"}
                          aria-label={markedDeleted ? "Undo column removal" : "Remove column"}
                          disabled={changingColumn !== null}
                        >
                          <Minus />
                        </Button>
                      )}
                    </div>
                  );
                })}
                {newColumnDrafts.map((draft) => {
                  const invalid = invalidNewColumnIds.has(draft.id);
                  return (
                    <div
                      key={draft.id}
                      className="grid grid-cols-[minmax(0,1fr)_220px_36px] border-b border-border bg-success/5 last:border-b-0"
                    >
                      <Input
                        aria-label="New column name"
                        value={draft.name}
                        onChange={(event) =>
                          setNewColumnDrafts((prev) =>
                            prev.map((candidate) =>
                              candidate.id === draft.id
                                ? { ...candidate, name: event.target.value }
                                : candidate
                            )
                          )
                        }
                        className={`h-9 rounded-none border-0 text-xs shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
                          invalid ? "bg-destructive/15 text-destructive" : ""
                        }`}
                        placeholder="new_column"
                        disabled={changingColumn !== null}
                      />
                      <div className="border-l border-border">
                        <Select
                          value={draft.dataType}
                          onValueChange={(dataType) =>
                            setNewColumnDrafts((prev) =>
                              prev.map((candidate) =>
                                candidate.id === draft.id ? { ...candidate, dataType } : candidate
                              )
                            )
                          }
                          disabled={changingColumn !== null}
                        >
                          <SelectTrigger
                            aria-label="New column data type"
                            className="h-9 rounded-none border-0 shadow-none focus:ring-1 focus:ring-inset"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {POSTGRES_COLUMN_TYPE_OPTIONS.map((type) => (
                              <SelectItem key={type} value={type}>
                                {type}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="rounded-none border-l border-border"
                        onClick={() =>
                          setNewColumnDrafts((prev) =>
                            prev.filter((candidate) => candidate.id !== draft.id)
                          )
                        }
                        title="Remove pending column"
                        aria-label="Remove pending column"
                        disabled={changingColumn !== null}
                      >
                        <Minus />
                      </Button>
                    </div>
                  );
                })}
              </>
            ) : canChangeColumnTypes ? null : (
              <EmptyState message="No columns." embedded />
            )}
          </PanelShell>
        ) : (
          <div className="border border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No table metadata loaded.
          </div>
        )}
        <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
          <p className="min-w-0">
            {canChangeColumnTypes
              ? "Saving runs PostgreSQL ALTER TABLE. PostgreSQL may reject incompatible or dependent changes."
              : currentTableType === "view"
                ? "Views are read-only in this editor."
                : "You can inspect column types, but changing them requires database admin query permission."}
          </p>
          {canChangeColumnTypes && (
            <div className="flex shrink-0 justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onReset}
                disabled={changingColumn !== null || schemaChangeCount === 0}
              >
                Reset
              </Button>
              <Button
                type="button"
                onClick={onSave}
                pending={changingColumn !== null}
                disabled={!canSaveColumnSchemaChanges}
              >
                {`Save${schemaChangeCount > 0 ? ` (${schemaChangeCount})` : ""}`}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
