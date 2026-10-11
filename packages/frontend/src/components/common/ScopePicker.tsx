import { FolderTree } from "lucide-react";
import { type ComponentProps, type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { ScopeList } from "@/components/common/ScopeList";
import {
  ScopeSearchFilter,
  type ScopeSelectionFilter,
} from "@/components/common/ScopeSearchFilter";
import {
  type FolderFamily,
  type FolderOption,
  folderFamilyForScope,
  folderTarget,
} from "@/components/common/scope-list-helpers";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const FOLDER_FAMILY_LABELS: Record<FolderFamily, string> = {
  groups: "Permission groups",
  users: "Users",
  domains: "Domains",
  proxy: "Routes",
  nodes: "Nodes",
  docker: "Docker containers",
  "docker-network": "Docker networks",
  "docker-volume": "Docker volumes",
  "docker-image": "Docker images",
  "docker-compose": "Compose projects",
  pages: "Pages",
  ssl: "SSL certificates",
  "pki-cas": "Certificate authorities",
  "pki-certificates": "PKI certificates",
  "nginx-templates": "Nginx templates",
  databases: "Databases",
  storage: "Storage",
  "logging-environments": "Logging environments",
  "logging-schemas": "Logging schemas",
};

type ScopeListProps = ComponentProps<typeof ScopeList>;

export interface ScopePickerProps extends Omit<ScopeListProps, "search" | "selectionFilter"> {
  /** The left side of the header row: a section title or a field label. */
  header?: ReactNode;
  /**
   * Enables "Limit selected scopes to folder…". Receives the restrictions with every selected
   * scope of the folder's family limited to that folder (and its subfolders).
   */
  onResourcesChange?: (resources: Record<string, string[]>) => void;
  searchPlaceholder?: string;
  /** The count line under the list. */
  footer: ReactNode;
  /** Rendered between the list and the footer. */
  children?: ReactNode;
  className?: string;
}

/**
 * The scope picker of every screen that grants scopes (OAuth consent, API tokens, groups,
 * users, OAuth applications): a header with the folder limit, search and selection filter,
 * the scope list with each restriction behind a one-line summary, and a count.
 */
export function ScopePicker({
  header,
  onResourcesChange,
  searchPlaceholder = "Search scopes...",
  footer,
  children,
  className,
  onFolderOptionsChange,
  ...listProps
}: ScopePickerProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ScopeSelectionFilter>("all");
  const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
  const foldersByFamily = useMemo(() => {
    const grouped = new Map<FolderFamily, FolderOption[]>();
    for (const folder of folderOptions) {
      grouped.set(folder.family, [...(grouped.get(folder.family) ?? []), folder]);
    }
    return [...grouped.entries()];
  }, [folderOptions]);
  const canLimit = !!onResourcesChange && foldersByFamily.length > 0;

  const limitSelectedScopesToFolder = (folder: FolderOption) => {
    const target = folderTarget(folder.id);
    const limited = listProps.selected.filter((scope) => {
      if (folderFamilyForScope(scope) !== folder.family) return false;
      if (!listProps.restrictableScopes?.includes(scope)) return false;
      const allowedIds = listProps.allowedResourceIds?.[scope];
      return !allowedIds || allowedIds.includes(target);
    });
    if (limited.length === 0) {
      toast.error(`No selected scope can be limited to ${folder.label}`);
      return;
    }
    onResourcesChange?.({
      ...(listProps.resources ?? {}),
      ...Object.fromEntries(limited.map((scope) => [scope, [target]])),
    });
    toast.success(
      `Limited ${limited.length} scope${limited.length === 1 ? "" : "s"} to ${folder.label}`
    );
  };

  return (
    <div className={cn("space-y-2", className)}>
      {(header || canLimit) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">{header}</div>
          {canLimit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" disabled={listProps.readOnly}>
                  <FolderTree className="h-4 w-4" />
                  Limit selected scopes to folder…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                {foldersByFamily.map(([family, folders]) => (
                  <DropdownMenuGroup key={family}>
                    <DropdownMenuLabel>{FOLDER_FAMILY_LABELS[family]}</DropdownMenuLabel>
                    {folders.map((folder) => (
                      <DropdownMenuItem
                        key={`${family}:${folder.id}`}
                        onSelect={() => limitSelectedScopesToFolder(folder)}
                      >
                        {folder.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-col border border-border">
        <ScopeSearchFilter
          search={search}
          onSearchChange={setSearch}
          filter={filter}
          onFilterChange={setFilter}
          placeholder={searchPlaceholder}
        />
        <ScopeList
          {...listProps}
          search={search}
          selectionFilter={filter}
          onResourcesChange={onResourcesChange}
          onFolderOptionsChange={(options) => {
            setFolderOptions(options);
            onFolderOptionsChange?.(options);
          }}
        />
        {children}
        <div className="border-t border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">{footer}</p>
        </div>
      </div>
    </div>
  );
}
