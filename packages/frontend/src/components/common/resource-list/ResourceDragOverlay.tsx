import { type Active, DragOverlay as DndDragOverlay } from "@dnd-kit/core";
import { Folder, Lock } from "lucide-react";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { Badge } from "@/components/ui/badge";
import { ResourceListItemRow } from "./ResourceListItemRow";
import type { ResourceListFolderConfig, ResourceListItemConfig } from "./types";
import { countFolderItems } from "./utils";

interface ResourceDragOverlayProps<TFolder, TItem> {
  active: Active | null;
  columns: ResourceListColumn<TItem>[];
  folderConfig: ResourceListFolderConfig<TFolder, TItem>;
  itemConfig: ResourceListItemConfig<TItem>;
}

export function ResourceDragOverlay<TFolder, TItem>({
  active,
  columns,
  folderConfig,
  itemConfig,
}: ResourceDragOverlayProps<TFolder, TItem>) {
  if (!active) return null;
  const folder = active.data.current?.folder as TFolder | undefined;
  const item = active.data.current?.item as TItem | undefined;

  return (
    <DndDragOverlay>
      {folder ? (
        <div className="flex min-w-80 items-center gap-2 border border-border bg-card px-3 py-2 shadow-lg opacity-95">
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          {folderConfig.isFolderSystem?.(folder) && (
            <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">{folderConfig.getFolderName(folder)}</span>
          <Badge variant="secondary" size="inline" className="ml-1">
            {countFolderItems(folder, folderConfig)}
          </Badge>
          {folderConfig.renderFolderBadges?.(folder)}
        </div>
      ) : item ? (
        <table
          className="w-full border border-border bg-card shadow-lg opacity-95"
          style={{ tableLayout: "fixed" }}
        >
          <colgroup>
            {columns.map((column) => (
              <col key={column.id} style={column.width ? { width: column.width } : undefined} />
            ))}
          </colgroup>
          <tbody>
            <ResourceListItemRow
              item={item}
              depth={0}
              columns={columns}
              config={itemConfig}
              isOverlay
            />
          </tbody>
        </table>
      ) : null}
    </DndDragOverlay>
  );
}
