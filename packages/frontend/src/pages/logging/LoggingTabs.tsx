import { EllipsisVertical, FileJson, ScrollText, Settings, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LoggingEnvironment, LoggingSchema } from "@/types";

const environmentColumns: ResourceListColumn<LoggingEnvironment>[] = [
  {
    id: "name",
    label: "Environment",
    width: "minmax(0, 1.5fr)",
    renderCell: (environment) => (
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-muted">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{environment.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {environment.slug}
            {environment.description ? ` · ${environment.description}` : ""}
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "schema",
    label: "Schema",
    width: "minmax(8rem, 0.8fr)",
    renderCell: (environment) => (
      <Badge variant="outline">{environment.schemaName ?? "No schema"}</Badge>
    ),
  },
  {
    id: "mode",
    label: "Mode",
    width: "7rem",
    renderCell: (environment) => <Badge variant="secondary">{environment.schemaMode}</Badge>,
  },
  {
    id: "retention",
    label: "Retention",
    width: "7rem",
    renderCell: (environment) => (
      <span className="text-sm text-muted-foreground">{environment.retentionDays}d</span>
    ),
  },
  {
    id: "status",
    label: "Status",
    width: "7rem",
    align: "right",
    renderCell: (environment) => (
      <Badge variant={environment.enabled ? "success" : "secondary"}>
        {environment.enabled ? "Enabled" : "Disabled"}
      </Badge>
    ),
  },
];

export function LoggingEnvironmentsTab({
  environments,
  search,
  loading,
  canCreate,
  canManageFolders,
  onSearchChange,
  onCreate,
  onOpen,
  onRefresh,
  onCreateFolderRef,
}: {
  environments: LoggingEnvironment[];
  search: string;
  loading: boolean;
  canCreate: boolean;
  canManageFolders: boolean;
  onSearchChange: (value: string) => void;
  onCreate: () => void;
  onOpen: (environment: LoggingEnvironment) => void;
  onRefresh: () => Promise<void> | void;
  onCreateFolderRef?: (fn: () => void) => void;
}) {
  return (
    <FolderedResourceList<LoggingEnvironment>
      resourceType="logging-environment"
      realtimeChannel="logging.environment.changed"
      resources={environments}
      columns={environmentColumns}
      search={{
        placeholder: "Search environments...",
        search,
        onSearchChange,
        hasActiveFilters: search !== "",
        onReset: () => onSearchChange(""),
      }}
      loading={loading}
      loadingLabel="Loading logging environments..."
      emptyState={
        <EmptyState
          message="No logging environments. Create an environment to receive logs from an external service."
          {...(canCreate ? { actionLabel: "Create Environment", onAction: onCreate } : {})}
          hasActiveFilters={search !== ""}
          onReset={() => onSearchChange("")}
        />
      }
      minWidth={920}
      canManageFolders={canManageFolders}
      canReorganizeItem={() => canManageFolders}
      getResourceLabel={(environment) => environment.name}
      onItemClick={onOpen}
      onRefresh={onRefresh}
      onCreateFolderRef={onCreateFolderRef}
    />
  );
}

function schemaColumns({
  canEdit,
  canDelete,
  onOpen,
  onDelete,
}: {
  canEdit: (schema: LoggingSchema) => boolean;
  canDelete: (schema: LoggingSchema) => boolean;
  onOpen: (schema: LoggingSchema) => void;
  onDelete: (schema: LoggingSchema) => Promise<boolean>;
}): ResourceListColumn<LoggingSchema>[] {
  return [
    {
      id: "name",
      label: "Schema",
      width: "minmax(0, 1.6fr)",
      renderCell: (schema) => (
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-muted">
            <FileJson className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{schema.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {schema.slug}
              {schema.description ? ` · ${schema.description}` : ""}
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "mode",
      label: "Mode",
      width: "7rem",
      renderCell: (schema) => <Badge variant="secondary">{schema.schemaMode}</Badge>,
    },
    {
      id: "fields",
      label: "Fields",
      width: "6rem",
      renderCell: (schema) => <Badge variant="outline">{schema.fieldSchema.length} fields</Badge>,
    },
    {
      id: "updated",
      label: "Updated",
      width: "8rem",
      renderCell: (schema) => (
        <RelativeTime value={schema.updatedAt} className="text-sm text-muted-foreground" />
      ),
    },
    {
      id: "actions",
      label: "Actions",
      width: "5.75rem",
      align: "right",
      renderCell: (schema) => {
        const hasActions = canEdit(schema) || canDelete(schema);
        if (!hasActions) return null;
        return (
          <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${schema.name}`}>
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit(schema) && (
                  <DropdownMenuItem
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(schema);
                    }}
                  >
                    <Settings className="h-3.5 w-3.5" />
                    Edit
                  </DropdownMenuItem>
                )}
                {canEdit(schema) && canDelete(schema) && <DropdownMenuSeparator />}
                {canDelete(schema) && (
                  <DropdownMenuItem
                    onClick={(event) => {
                      event.stopPropagation();
                      void onDelete(schema);
                    }}
                    className="text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];
}

export function LoggingSchemasTab({
  schemas,
  search,
  loading,
  canCreate,
  canManageFolders,
  canEdit,
  canDelete,
  canOpen,
  onSearchChange,
  onCreate,
  onOpen,
  onDelete,
  onRefresh,
  onCreateFolderRef,
}: {
  schemas: LoggingSchema[];
  search: string;
  loading: boolean;
  canCreate: boolean;
  canManageFolders: boolean;
  canEdit: (schema: LoggingSchema) => boolean;
  canDelete: (schema: LoggingSchema) => boolean;
  canOpen: (schema: LoggingSchema) => boolean;
  onSearchChange: (value: string) => void;
  onCreate: () => void;
  onOpen: (schema: LoggingSchema) => void;
  onDelete: (schema: LoggingSchema) => Promise<boolean>;
  onRefresh: () => Promise<void> | void;
  onCreateFolderRef?: (fn: () => void) => void;
}) {
  return (
    <FolderedResourceList<LoggingSchema>
      resourceType="logging-schema"
      realtimeChannel="logging.schema.changed"
      resources={schemas}
      columns={schemaColumns({ canEdit, canDelete, onOpen, onDelete })}
      search={{
        placeholder: "Search schemas...",
        search,
        onSearchChange,
        hasActiveFilters: search !== "",
        onReset: () => onSearchChange(""),
      }}
      loading={loading}
      loadingLabel="Loading logging schemas..."
      emptyState={
        <EmptyState
          message="No logging schemas. Create a reusable schema and attach it to environments."
          {...(canCreate ? { actionLabel: "Create Schema", onAction: onCreate } : {})}
          hasActiveFilters={search !== ""}
          onReset={() => onSearchChange("")}
        />
      }
      minWidth={920}
      canManageFolders={canManageFolders}
      canViewItem={canOpen}
      canReorganizeItem={() => canManageFolders}
      getResourceLabel={(schema) => schema.name}
      onItemClick={(schema) => {
        if (canOpen(schema)) onOpen(schema);
      }}
      onRefresh={onRefresh}
      onCreateFolderRef={onCreateFolderRef}
    />
  );
}
