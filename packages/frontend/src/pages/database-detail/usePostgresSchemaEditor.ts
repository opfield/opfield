import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { DatabaseConnection, SqlTableMetadata } from "@/types";
import {
  currentColumnTypeValue,
  type NewColumnDraft,
  POSTGRES_IDENTIFIER_PATTERN,
} from "./postgres-explorer-state";

export function usePostgresSchemaEditor(input: {
  database: DatabaseConnection;
  metadata: SqlTableMetadata | null;
  namespace: string;
  table: string;
  currentTableType: string | undefined;
  canAdmin: boolean;
  reloadRows: (page?: number, append?: boolean) => Promise<void>;
}) {
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [changingColumn, setChangingColumn] = useState<string | null>(null);
  const [columnTypeDrafts, setColumnTypeDrafts] = useState<Record<string, string>>({});
  const [newColumnDrafts, setNewColumnDrafts] = useState<NewColumnDraft[]>([]);
  const [deletedColumnNames, setDeletedColumnNames] = useState<string[]>([]);
  const canChangeColumnTypes =
    input.canAdmin && input.database.type === "postgres" && input.currentTableType === "table";

  useEffect(() => {
    if (!columnsOpen || !input.metadata) return;
    setColumnTypeDrafts(
      Object.fromEntries(
        input.metadata.columns.map((column) => [column.name, currentColumnTypeValue(column)])
      )
    );
    setNewColumnDrafts([]);
    setDeletedColumnNames([]);
  }, [columnsOpen, input.metadata]);

  const invalidNewColumnIds = useMemo(() => {
    const seen = new Set(
      input.metadata?.columns
        .filter((column) => !deletedColumnNames.includes(column.name))
        .map((column) => column.name) ?? []
    );
    const invalid = new Set<string>();
    for (const draft of newColumnDrafts) {
      const name = draft.name.trim();
      if (!name || !POSTGRES_IDENTIFIER_PATTERN.test(name) || seen.has(name)) invalid.add(draft.id);
      if (name) seen.add(name);
    }
    return invalid;
  }, [deletedColumnNames, input.metadata, newColumnDrafts]);

  const changedColumnTypes = useMemo(
    () =>
      input.metadata?.columns
        .map((column) => ({
          column,
          dataType: columnTypeDrafts[column.name] ?? currentColumnTypeValue(column),
        }))
        .filter(
          ({ column, dataType }) =>
            !deletedColumnNames.includes(column.name) && dataType !== currentColumnTypeValue(column)
        ) ?? [],
    [columnTypeDrafts, deletedColumnNames, input.metadata]
  );
  const schemaChangeCount =
    changedColumnTypes.length + deletedColumnNames.length + newColumnDrafts.length;
  const canSaveColumnSchemaChanges =
    canChangeColumnTypes &&
    changingColumn === null &&
    schemaChangeCount > 0 &&
    invalidNewColumnIds.size === 0;

  const resetColumnSchemaDrafts = () => {
    setColumnTypeDrafts(
      Object.fromEntries(
        input.metadata?.columns.map((column) => [column.name, currentColumnTypeValue(column)]) ?? []
      )
    );
    setNewColumnDrafts([]);
    setDeletedColumnNames([]);
  };

  const saveColumnSchemaChanges = async () => {
    if (!input.metadata || !input.namespace || !input.table || !canSaveColumnSchemaChanges) return;
    try {
      for (const name of deletedColumnNames) {
        setChangingColumn(name);
        await api.deletePostgresColumn(input.database.id, input.namespace, input.table, name);
      }
      for (const change of changedColumnTypes) {
        setChangingColumn(change.column.name);
        await api.updatePostgresColumnType(
          input.database.id,
          input.namespace,
          input.table,
          change.column.name,
          change.dataType
        );
      }
      for (const draft of newColumnDrafts) {
        setChangingColumn(draft.name.trim());
        await api.addPostgresColumn(
          input.database.id,
          input.namespace,
          input.table,
          draft.name.trim(),
          draft.dataType
        );
      }
      toast.success("Column schema updated");
      setNewColumnDrafts([]);
      setDeletedColumnNames([]);
      await input.reloadRows(1, false);
    } catch (error) {
      toastApiError(error, "Failed to update columns");
    } finally {
      setChangingColumn(null);
    }
  };

  return {
    canChangeColumnTypes,
    columnsOpen,
    setColumnsOpen,
    changingColumn,
    columnTypeDrafts,
    setColumnTypeDrafts,
    newColumnDrafts,
    setNewColumnDrafts,
    deletedColumnNames,
    setDeletedColumnNames,
    invalidNewColumnIds,
    schemaChangeCount,
    canSaveColumnSchemaChanges,
    resetColumnSchemaDrafts,
    saveColumnSchemaChanges,
  };
}
