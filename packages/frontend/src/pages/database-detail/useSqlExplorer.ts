import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type {
  DatabaseConnection,
  SqlBrowseResult,
  SqlNamespace,
  SqlObjectSummary,
  SqlTableMetadata,
} from "@/types";
import type { PostgresSearchOperation } from "./postgres-explorer-state";
import {
  buildRowLocator,
  coerceCellInput,
  getPendingRowState,
  getRowKey,
  hasMoreSqlRows,
  isBlankValue,
  isPendingRowValid,
  SQL_EXPLORER_PAGE_SIZE,
  VIRTUAL_ROW_HEIGHT,
  valuesEqual,
} from "./shared";
import { usePostgresSchemaEditor } from "./usePostgresSchemaEditor";

export function useSqlExplorer(database: DatabaseConnection, canAdmin: boolean) {
  const [schemas, setSchemas] = useState<SqlNamespace[]>([]);
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState<SqlObjectSummary[]>([]);
  const [table, setTable] = useState("");
  const [metadata, setMetadata] = useState<SqlTableMetadata | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [draftRows, setDraftRows] = useState<Record<string, Record<string, unknown>>>({});
  const [newRows, setNewRows] = useState<Array<Record<string, unknown>>>([]);
  const [saving, setSaving] = useState(false);
  const [loadingSchemas, setLoadingSchemas] = useState(true);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalRows, setTotalRows] = useState<number | null>(0);
  const [totalKind, setTotalKind] = useState<SqlBrowseResult["totalKind"]>("exact");
  const [rowsTruncated, setRowsTruncated] = useState(false);
  const [loadingMoreRows, setLoadingMoreRows] = useState(false);
  const [sortBy, setSortBy] = useState<string>();
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [searchColumn, setSearchColumn] = useState("");
  const [searchOperation, setSearchOperation] = useState<PostgresSearchOperation>("like");
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearchColumn, setAppliedSearchColumn] = useState("");
  const [appliedSearchOperation, setAppliedSearchOperation] =
    useState<PostgresSearchOperation>("like");
  const [searchValue, setSearchValue] = useState("");
  const explorerScrollRef = useRef<HTMLDivElement>(null);
  const rowRequestRef = useRef(0);

  const resetRows = useCallback(() => {
    rowRequestRef.current += 1;
    setMetadata(null);
    setRows([]);
    setDraftRows({});
    setNewRows([]);
    setCurrentPage(1);
    setTotalRows(0);
    setTotalKind("exact");
    setRowsTruncated(false);
    setLoadingMoreRows(false);
    setLoadingRows(false);
  }, []);

  const resetFilters = useCallback(() => {
    setSortBy(undefined);
    setSortOrder("asc");
    setSearchColumn("");
    setSearchInput("");
    setAppliedSearchColumn("");
    setAppliedSearchOperation("like");
    setSearchOperation("like");
    setSearchValue("");
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingSchemas(true);
    setSchemas([]);
    setSchema("");
    setTables([]);
    setTable("");
    resetRows();
    resetFilters();
    api
      .listSqlNamespaces(database.id)
      .then((data) => {
        if (cancelled) return;
        setSchemas(data);
        const preferred = data.find((item) => item.name === database.databaseName);
        const firstUserNamespace = data.find((item) => !item.system);
        setSchema(preferred?.name ?? firstUserNamespace?.name ?? data[0]?.name ?? "");
      })
      .catch((error) => {
        if (!cancelled) {
          toastApiError(error, "Failed to load schemas");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSchemas(false);
      });
    return () => {
      cancelled = true;
    };
  }, [database.databaseName, database.id, resetFilters, resetRows]);

  useEffect(() => {
    if (!schema) return;
    let cancelled = false;
    setLoadingTables(true);
    setTables([]);
    setTable("");
    resetRows();
    resetFilters();
    api
      .listSqlObjects(database.id, schema)
      .then((data) => {
        if (cancelled) return;
        setTables(data);
        setTable(data[0]?.name ?? "");
      })
      .catch((error) => {
        if (!cancelled) {
          toastApiError(error, "Failed to load tables");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false);
      });
    return () => {
      cancelled = true;
    };
  }, [database.id, resetFilters, resetRows, schema]);

  useEffect(() => {
    if (table || loadingSchemas || loadingTables) return;
    setLoadingRows(false);
    resetRows();
  }, [loadingSchemas, loadingTables, resetRows, table]);

  const activeSearchColumn = searchValue ? appliedSearchColumn : "";
  const activeSearchOperation = searchValue ? appliedSearchOperation : "like";
  const loadRows = useCallback(
    async (page = 1, append = false) => {
      if (!schema || !table) return;
      const requestId = ++rowRequestRef.current;
      if (!append) setLoadingRows(true);
      try {
        const data = await api.browseSqlRows(database.id, {
          namespace: schema,
          table,
          page,
          limit: SQL_EXPLORER_PAGE_SIZE,
          sortBy,
          sortOrder,
          ...(activeSearchColumn && searchValue
            ? {
                searchColumn: activeSearchColumn,
                searchOperation: activeSearchOperation,
                searchValue,
              }
            : {}),
        });
        if (rowRequestRef.current !== requestId) return;
        setMetadata(data.metadata);
        setRows((current) => (append ? [...current, ...data.rows] : data.rows));
        setCurrentPage(data.page);
        setTotalRows(data.total);
        setTotalKind(data.totalKind);
        setRowsTruncated(data.truncated);
        if (!append) {
          setDraftRows({});
          setNewRows([]);
        }
      } catch (error) {
        if (rowRequestRef.current !== requestId) return;
        toastApiError(error, "Failed to load rows");
        if (!append) resetRows();
      } finally {
        if (!append && rowRequestRef.current === requestId) setLoadingRows(false);
      }
    },
    [
      activeSearchColumn,
      activeSearchOperation,
      database.id,
      resetRows,
      schema,
      searchValue,
      sortBy,
      sortOrder,
      table,
    ]
  );

  useEffect(() => {
    void loadRows(1, false);
  }, [loadRows]);

  const hasMoreRows = hasMoreSqlRows({
    loadedRows: rows.length,
    total: totalRows,
    totalKind,
    pageTruncated: rowsTruncated,
  });
  const loadMoreRows = useCallback(async () => {
    if (!hasMoreRows || loadingMoreRows || refreshing || saving) return;
    setLoadingMoreRows(true);
    try {
      await loadRows(currentPage + 1, true);
    } finally {
      setLoadingMoreRows(false);
    }
  }, [currentPage, hasMoreRows, loadRows, loadingMoreRows, refreshing, saving]);

  useEffect(() => {
    const node = explorerScrollRef.current;
    if (!node) return;
    const onScroll = () => {
      if (node.scrollTop + node.clientHeight >= node.scrollHeight - 320) void loadMoreRows();
    };
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, [loadMoreRows]);

  useEffect(() => {
    const node = explorerScrollRef.current;
    if (node && hasMoreRows && !loadingMoreRows && node.scrollHeight <= node.clientHeight + 1) {
      void loadMoreRows();
    }
  }, [hasMoreRows, loadingMoreRows, loadMoreRows]);

  useEffect(() => {
    if (metadata && sortBy && !metadata.columns.some((column) => column.name === sortBy)) {
      setSortBy(undefined);
      setSortOrder("asc");
    }
    if (!metadata) return;
    if (!searchColumn || !metadata.columns.some((column) => column.name === searchColumn)) {
      setSearchColumn(metadata.columns[0]?.name ?? "");
    }
  }, [metadata, searchColumn, sortBy]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => explorerScrollRef.current,
    estimateSize: () => VIRTUAL_ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index) => (metadata ? getRowKey(metadata, rows[index] ?? {}) : index),
  });
  const currentTableType = tables.find((candidate) => candidate.name === table)?.type;
  const schemaEditor = usePostgresSchemaEditor({
    database,
    metadata,
    namespace: schema,
    table,
    currentTableType,
    canAdmin,
    reloadRows: loadRows,
  });

  const validPendingRows = useMemo(
    () => (metadata ? newRows.filter((row) => isPendingRowValid(row, metadata.columns)) : []),
    [metadata, newRows]
  );
  const pendingRowStates = useMemo(
    () => (metadata ? newRows.map((row) => getPendingRowState(row, metadata.columns)) : []),
    [metadata, newRows]
  );
  const editedRowCount = useMemo(() => {
    if (!metadata) return 0;
    return rows.filter((row) => draftRows[getRowKey(metadata, row)]).length;
  }, [draftRows, metadata, rows]);
  const dirtyCount = editedRowCount + validPendingRows.length;
  const canSaveChanges =
    !saving &&
    dirtyCount > 0 &&
    !pendingRowStates.some((state) => state === "invalid" || state === "empty");

  const selectSchema = (value: string) => {
    setTables([]);
    setTable("");
    resetRows();
    resetFilters();
    setSchema(value);
  };
  const selectTable = (value: string) => {
    resetRows();
    resetFilters();
    setTable(value);
  };
  const updateDraftRow = (
    row: Record<string, unknown>,
    column: SqlTableMetadata["columns"][number],
    raw: string
  ) => {
    if (!metadata) return;
    const key = getRowKey(metadata, row);
    const nextDraft = { ...(draftRows[key] ?? row), [column.name]: coerceCellInput(column, raw) };
    const matchesOriginal = metadata.columns.every((candidate) =>
      valuesEqual(nextDraft[candidate.name], row[candidate.name])
    );
    setDraftRows((current) => {
      if (!matchesOriginal) return { ...current, [key]: nextDraft };
      const next = { ...current };
      delete next[key];
      return next;
    });
  };
  const updateNewRow = (
    rowIndex: number,
    column: SqlTableMetadata["columns"][number],
    raw: string
  ) => {
    setNewRows((current) =>
      current.map((row, index) =>
        index === rowIndex ? { ...row, [column.name]: coerceCellInput(column, raw) } : row
      )
    );
  };
  const saveChanges = async () => {
    if (!metadata || !schema || !table) return;
    setSaving(true);
    try {
      for (const row of rows) {
        const draft = draftRows[getRowKey(metadata, row)];
        if (!draft) continue;
        const values = Object.fromEntries(
          metadata.columns
            .filter((column) => !valuesEqual(draft[column.name], row[column.name]))
            .map((column) => [column.name, draft[column.name]])
        );
        await api.updateSqlRow(database.id, schema, table, buildRowLocator(metadata, row), values);
      }
      for (const pendingRow of validPendingRows) {
        const values = Object.fromEntries(
          Object.entries(pendingRow).filter(([, value]) => !isBlankValue(value))
        );
        await api.insertSqlRow(database.id, schema, table, values);
      }
      toast.success("Table changes saved");
      await loadRows();
    } catch (error) {
      toastApiError(error, "Failed to save table changes");
    } finally {
      setSaving(false);
    }
  };
  const refreshRows = async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadRows(1, false), new Promise((resolve) => setTimeout(resolve, 500))]);
    } finally {
      setRefreshing(false);
    }
  };
  const applySearch = () => {
    setAppliedSearchColumn(searchColumn);
    setAppliedSearchOperation(searchOperation);
    setSearchValue(searchInput.trim());
  };
  const updateSearchInput = (value: string) => {
    setSearchInput(value);
    if (!value) setSearchValue("");
  };
  const toggleSort = (columnName: string) => {
    if (sortBy !== columnName) {
      setSortBy(columnName);
      setSortOrder("asc");
    } else if (sortOrder === "asc") {
      setSortOrder("desc");
    } else {
      setSortBy(undefined);
      setSortOrder("asc");
    }
  };
  const deleteRow = async (row: Record<string, unknown>) => {
    if (!metadata) return;
    try {
      await api.deleteSqlRow(database.id, schema, table, buildRowLocator(metadata, row));
      toast.success("Row deleted");
      await loadRows();
    } catch (error) {
      toastApiError(error, "Failed to delete row");
    }
  };
  return {
    schemas,
    schema,
    selectSchema,
    tables,
    table,
    selectTable,
    metadata,
    rows,
    draftRows,
    newRows,
    setNewRows,
    saving,
    loadingSchemas,
    loadingTables,
    loadingRows,
    loadingExplorer: loadingSchemas || loadingTables || loadingRows,
    refreshing,
    totalRows,
    totalKind,
    loadingMoreRows,
    sortBy,
    sortOrder,
    searchColumn,
    setSearchColumn,
    searchOperation,
    setSearchOperation,
    searchInput,
    explorerScrollRef,
    rowVirtualizer,
    virtualRows: rowVirtualizer.getVirtualItems(),
    gridTemplateColumns: metadata ? `repeat(${metadata.columns.length}, minmax(220px, 1fr))` : "",
    gridWidth: metadata ? `max(100%, ${metadata.columns.length * 220}px)` : "100%",
    currentTableType,
    ...schemaEditor,
    pendingRowStates,
    dirtyCount,
    canSaveChanges,
    updateDraftRow,
    updateNewRow,
    saveChanges,
    refreshRows,
    applySearch,
    updateSearchInput,
    toggleSort,
    deleteRow,
  };
}
