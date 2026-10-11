import { DndContext, MeasuringStrategy } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ResourceListFrame, ResourceListHeaderTable } from "@/components/common/ResourceListLayout";
import { ResourceDragOverlay } from "@/components/common/resource-list/ResourceDragOverlay";
import { ResourceFolderGroup } from "@/components/common/resource-list/ResourceFolderGroup";
import { ResourceUngroupedSection } from "@/components/common/resource-list/ResourceUngroupedSection";
import type { ResourceListFormProps } from "@/components/common/resource-list/types";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { pointerFirstCollisionDetection } from "@/lib/dnd-collision";

export function ResourceListForm<TFolder, TItem>({
  columns,
  search,
  folders,
  items,
  dnd,
  minWidth = 900,
  embedded = false,
  loading,
  loadingLabel = "Loading...",
  hasContent,
  emptyState,
  afterSearch,
}: ResourceListFormProps<TFolder, TItem>) {
  const topLevelFolders = folders.folders;
  const ungroupedItems = folders.ungroupedItems;
  const initialLoading = useInitialLoading(Boolean(loading));
  const showLoading = initialLoading && !hasContent;
  useContentLoading(initialLoading);
  const frame = (
    <ResourceListFrame minWidth={minWidth} className={embedded ? "border-0 text-sm" : undefined}>
      <ResourceListHeaderTable columns={columns} />
      {topLevelFolders.length > 0 && (
        <SortableContext
          items={topLevelFolders.map(folders.getFolderSortableId)}
          strategy={verticalListSortingStrategy}
        >
          {topLevelFolders.map((folder) => (
            <ResourceFolderGroup
              key={folders.getFolderId(folder)}
              folder={folder}
              depth={folders.getFolderDepth?.(folder) ?? 0}
              columns={columns}
              folderConfig={folders}
              itemConfig={items}
            />
          ))}
        </SortableContext>
      )}
      {(topLevelFolders.length > 0 || ungroupedItems.length > 0) && (
        <ResourceUngroupedSection
          columns={columns}
          items={ungroupedItems}
          itemConfig={items}
          folderConfig={folders}
          showHeader={topLevelFolders.length > 0}
        />
      )}
    </ResourceListFrame>
  );
  // The first load keeps the page hidden (reported below), so nothing stands in for the rows.
  const loadingFrame = <div aria-label={loadingLabel} aria-busy="true" />;

  return (
    <div className={embedded ? undefined : "space-y-3"}>
      <SearchFilterBar
        {...search}
        className={embedded ? "border-b border-border" : undefined}
        inputClassName={embedded ? "h-12 border-0 shadow-none focus-visible:ring-inset" : undefined}
      />
      {afterSearch}
      {showLoading ? (
        loadingFrame
      ) : hasContent ? (
        <DndContext
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          sensors={dnd?.sensors}
          collisionDetection={dnd?.collisionDetection ?? pointerFirstCollisionDetection}
          onDragStart={dnd?.onDragStart}
          onDragEnd={dnd?.onDragEnd}
          onDragCancel={dnd?.onDragCancel}
        >
          {frame}
          {dnd && (
            <ResourceDragOverlay
              active={dnd.active}
              columns={columns}
              folderConfig={folders}
              itemConfig={items}
            />
          )}
        </DndContext>
      ) : (
        emptyState
      )}
    </div>
  );
}
