import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
} from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DatabaseConnection } from "@/types";
import { PostgresColumnSchemaDialog } from "./PostgresColumnSchemaDialog";
import {
  POSTGRES_SEARCH_OPERATIONS,
  type PostgresSearchOperation,
} from "./postgres-explorer-state";
import { getRowKey, isBlankValue, stringifyCell } from "./shared";
import { useSqlExplorer } from "./useSqlExplorer";

export function SqlExplorer({
  database,
  canWrite,
  canAdmin,
  focused,
  onToggleFocus,
}: {
  database: DatabaseConnection;
  canWrite: boolean;
  canAdmin: boolean;
  focused: boolean;
  onToggleFocus: () => void;
}) {
  const explorer = useSqlExplorer(database, canAdmin);
  const {
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
    loadingExplorer,
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
    virtualRows,
    gridTemplateColumns,
    gridWidth,
    currentTableType,
    canChangeColumnTypes,
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
  } = explorer;
  // Schemas, then the first schema's tables, then the first table's rows.
  useContentLoading(loadingExplorer);
  const hasSchemas = schemas.length > 0;
  const hasTables = tables.length > 0;
  const emptyExplorerMessage = !hasSchemas
    ? "No schemas found."
    : !hasTables
      ? `No tables found in ${schema || "this schema"}.`
      : "No table selected.";
  const panelDescription = metadata
    ? `${metadata.columns.length} columns${
        metadata.mutations.rowUpdate
          ? " · editable grid"
          : ` · ${metadata.mutations.reason ?? "existing rows are browse-only"}`
      }${
        totalRows == null
          ? ""
          : ` · ${totalKind === "approximate" ? "~" : ""}${totalRows.toLocaleString()} rows`
      }`
    : "Loading table rows...";

  return (
    <div className={`flex flex-col flex-1 min-h-0 ${focused ? "gap-0" : "gap-4"}`}>
      {!focused && (
        <div className="grid shrink-0 grid-cols-[minmax(0,0.9fr)_minmax(0,1.25fr)_auto] items-end gap-2 sm:flex sm:flex-wrap sm:gap-3">
          <div className="min-w-0">
            <Select
              value={schema}
              onValueChange={selectSchema}
              disabled={loadingSchemas || !hasSchemas}
            >
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Schema" />
              </SelectTrigger>
              <SelectContent>
                {schemas.map((item) => (
                  <SelectItem key={item.name} value={item.name}>
                    {item.name}
                    {item.system ? " · system" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0">
            <Select
              value={table}
              onValueChange={selectTable}
              disabled={loadingTables || !schema || !hasTables}
            >
              <SelectTrigger className="w-full sm:w-[260px]">
                <SelectValue placeholder={loadingTables ? "Loading tables..." : "Table"} />
              </SelectTrigger>
              <SelectContent>
                {tables.map((item) => (
                  <SelectItem key={item.name} value={item.name}>
                    {item.name} ({item.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="sm:w-auto sm:px-4"
            onClick={() => void refreshRows()}
            disabled={refreshing || loadingExplorer || !table}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing || loadingRows ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      )}

      {table ? (
        <PanelShell
          className={`flex flex-col min-h-0 max-h-full ${focused ? "border-l-0" : ""}`}
          title={metadata ? `${metadata.namespace}.${metadata.table}` : `${schema}.${table}`}
          description={panelDescription}
          bodyClassName="flex flex-col min-h-0 flex-1"
          actions={
            <>
              {database.type === "postgres" && metadata && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => explorer.setColumnsOpen(true)}
                  title="Column types"
                  aria-label="Column types"
                >
                  <Settings />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggleFocus}
                title={focused ? "Collapse explorer" : "Expand explorer"}
                aria-label={focused ? "Collapse explorer" : "Expand explorer"}
              >
                {focused ? <Minimize2 /> : <Maximize2 />}
              </Button>
              {canWrite && metadata?.mutations.rowInsert && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() =>
                    setNewRows((current) => [
                      ...current,
                      Object.fromEntries(metadata.columns.map((column) => [column.name, null])),
                    ])
                  }
                  title="Insert row"
                  aria-label="Insert row"
                >
                  <Plus />
                </Button>
              )}
              {canWrite &&
                metadata &&
                (metadata.mutations.rowInsert || metadata.mutations.rowUpdate) && (
                  <Button
                    onClick={() => void saveChanges()}
                    pending={saving}
                    disabled={!canSaveChanges}
                  >
                    <Save />
                    {`Save${dirtyCount > 0 ? ` (${dirtyCount})` : ""}`}
                  </Button>
                )}
            </>
          }
        >
          {loadingRows || !metadata ? (
            // Switching tables keeps the panel; the Refresh icon spins while rows load.
            <div className="min-h-40 flex-1" aria-busy="true" aria-label="Loading table rows" />
          ) : (
            <>
              {metadata.columns.length > 0 && (
                <div className="grid grid-cols-[minmax(0,1fr)_88px_minmax(0,1fr)_36px] border-b border-border bg-card sm:grid-cols-[minmax(180px,260px)_120px_minmax(220px,1fr)_36px]">
                  <Select value={searchColumn} onValueChange={setSearchColumn}>
                    <SelectTrigger className="rounded-none border-0 border-r border-border shadow-none focus:ring-1 focus:ring-inset">
                      <SelectValue placeholder="Column" />
                    </SelectTrigger>
                    <SelectContent className="bg-background text-foreground">
                      {metadata.columns.map((column) => (
                        <SelectItem key={column.name} value={column.name}>
                          {column.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={searchOperation}
                    onValueChange={(value) => setSearchOperation(value as PostgresSearchOperation)}
                  >
                    <SelectTrigger className="rounded-none border-0 border-r border-border shadow-none focus:ring-1 focus:ring-inset">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-background text-foreground">
                      {POSTGRES_SEARCH_OPERATIONS.map((operation) => (
                        <SelectItem key={operation.value} value={operation.value}>
                          {operation.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={searchInput}
                    onChange={(event) => updateSearchInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") applySearch();
                    }}
                    className="rounded-none border-0 border-r border-border font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-inset"
                    placeholder="Search value"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="rounded-none bg-background"
                    onClick={applySearch}
                    title="Search"
                    aria-label="Search rows"
                  >
                    <Search />
                  </Button>
                </div>
              )}

              <div
                ref={explorerScrollRef}
                className="dashboard-scrollbar overflow-auto flex-1 min-h-0"
              >
                {metadata.columns.length > 0 && (
                  <div
                    className="grid border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider sticky top-0 bg-card z-10"
                    style={{ gridTemplateColumns, width: gridWidth }}
                  >
                    {metadata.columns.map((column) => (
                      <div key={column.name} className="border-r border-border last:border-r-0">
                        <button
                          type="button"
                          className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
                          onClick={() => toggleSort(column.name)}
                          title={`Sort by ${column.name}`}
                        >
                          <span className="min-w-0 truncate">{column.name}</span>
                          <span className="ml-auto text-muted-foreground/80">
                            {sortBy === column.name ? (
                              sortOrder === "asc" ? (
                                <ChevronUp className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                            )}
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {rows.length === 0 && newRows.length === 0 && (
                  <EmptyState message="No rows found." embedded />
                )}

                <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                  {virtualRows.map((virtualRow) => {
                    const row = rows[virtualRow.index];
                    if (!row) return null;
                    const rowKey = getRowKey(metadata, row);
                    const draft = draftRows[rowKey] ?? row;
                    const isLastLoadedRow =
                      virtualRow.index === rows.length - 1 &&
                      newRows.length === 0 &&
                      !loadingMoreRows;
                    return (
                      <div
                        key={rowKey}
                        data-index={virtualRow.index}
                        ref={rowVirtualizer.measureElement}
                        className={`absolute left-0 grid ${isLastLoadedRow ? "" : "border-b border-border"}`}
                        style={{
                          transform: `translateY(${virtualRow.start}px)`,
                          gridTemplateColumns,
                          width: gridWidth,
                        }}
                      >
                        {metadata.columns.map((column, columnIndex) => {
                          const isLastColumn = columnIndex === metadata.columns.length - 1;
                          const isImmutable = metadata.mutations.immutableColumns.includes(
                            column.name
                          );
                          const canInlineDelete =
                            canWrite && metadata.mutations.rowDelete && isLastColumn;
                          const value = stringifyCell(draft[column.name]);
                          return (
                            <div
                              key={column.name}
                              className="flex min-w-0 items-center border-r border-border last:border-r-0"
                            >
                              {canWrite && metadata.mutations.rowUpdate && !isImmutable ? (
                                <Input
                                  value={value}
                                  onChange={(event) =>
                                    updateDraftRow(row, column, event.target.value)
                                  }
                                  className="h-9 min-w-0 flex-1 rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                                />
                              ) : (
                                <div
                                  className={`min-h-9 min-w-0 flex-1 overflow-hidden truncate whitespace-nowrap px-3 py-2 font-mono text-xs ${isImmutable ? "bg-muted/25" : ""}`}
                                  title={value || "NULL"}
                                >
                                  {value || <span className="text-muted-foreground">NULL</span>}
                                </div>
                              )}
                              {canInlineDelete && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="rounded-none border-l border-border"
                                  onClick={() => void deleteRow(row)}
                                  title="Delete row"
                                  aria-label="Delete row"
                                >
                                  <Minus />
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>

                <div>
                  {newRows.map((newRow, rowIndex) => (
                    <div
                      key={`new-${rowIndex}`}
                      className={`grid border-border bg-success/5 ${
                        rowIndex === newRows.length - 1 ? "" : "border-b"
                      }`}
                      style={{ gridTemplateColumns, width: gridWidth }}
                    >
                      {metadata.columns.map((column, columnIndex) => {
                        const isLastColumn = columnIndex === metadata.columns.length - 1;
                        const input = (
                          <Input
                            value={stringifyCell(newRow[column.name])}
                            onChange={(event) => updateNewRow(rowIndex, column, event.target.value)}
                            className={`h-9 min-w-0 flex-1 rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
                              pendingRowStates[rowIndex] === "invalid" &&
                              !column.nullable &&
                              !column.hasDefault &&
                              isBlankValue(newRow[column.name])
                                ? "bg-destructive/15 text-destructive"
                                : ""
                            }`}
                          />
                        );
                        return (
                          <div
                            key={column.name}
                            className="flex items-center border-r border-border last:border-r-0"
                          >
                            {input}
                            {isLastColumn && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="rounded-none border-l border-border"
                                onClick={() =>
                                  setNewRows((current) =>
                                    current.filter((_, index) => index !== rowIndex)
                                  )
                                }
                                title="Remove pending row"
                                aria-label="Remove pending row"
                              >
                                <Minus />
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {loadingMoreRows && (
                    <div className="flex items-center justify-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading more rows
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </PanelShell>
      ) : loadingSchemas || loadingTables ? (
        // A schema switch keeps a panel-sized frame while its tables load.
        <div
          className="min-h-40 border border-border bg-card"
          aria-busy="true"
          aria-label="Loading database explorer"
        />
      ) : (
        <EmptyState message={emptyExplorerMessage} />
      )}

      {database.type === "postgres" && (
        <PostgresColumnSchemaDialog
          open={explorer.columnsOpen}
          onOpenChange={explorer.setColumnsOpen}
          metadata={metadata}
          canChangeColumnTypes={canChangeColumnTypes}
          currentTableType={currentTableType}
          columnTypeDrafts={explorer.columnTypeDrafts}
          setColumnTypeDrafts={explorer.setColumnTypeDrafts}
          newColumnDrafts={explorer.newColumnDrafts}
          setNewColumnDrafts={explorer.setNewColumnDrafts}
          deletedColumnNames={explorer.deletedColumnNames}
          setDeletedColumnNames={explorer.setDeletedColumnNames}
          invalidNewColumnIds={explorer.invalidNewColumnIds}
          changingColumn={explorer.changingColumn}
          schemaChangeCount={explorer.schemaChangeCount}
          canSaveColumnSchemaChanges={explorer.canSaveColumnSchemaChanges}
          onReset={explorer.resetColumnSchemaDrafts}
          onSave={() => void explorer.saveColumnSchemaChanges()}
        />
      )}
    </div>
  );
}
