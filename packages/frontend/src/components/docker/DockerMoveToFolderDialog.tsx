import { ChevronRight, Folder, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { cn } from "@/lib/utils";
import type { DockerFolderTreeNode } from "@/types";

interface DockerMoveToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: DockerFolderTreeNode[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
  /** Destinations the caller may move the container into (defaults to every folder and the root). */
  canMoveTo?: (folderId: string | null) => boolean;
}

const allowEveryDestination = () => true;

function FolderOption({
  folder,
  depth,
  selected,
  onSelect,
  canMoveTo,
}: {
  folder: DockerFolderTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  canMoveTo: (folderId: string | null) => boolean;
}) {
  const allowed = !folder.isSystem && canMoveTo(folder.id);
  return (
    <>
      {/* A selectable tree row, not an action button. */}
      <button
        type="button"
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors",
          allowed ? "hover:bg-accent" : "opacity-50 cursor-not-allowed",
          selected === folder.id && "bg-accent"
        )}
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
        disabled={!allowed}
        onClick={() => {
          if (allowed) onSelect(folder.id);
        }}
      >
        {folder.children.length > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        <Folder className="h-4 w-4 text-muted-foreground" />
        {folder.isSystem && <Lock className="h-3 w-3 text-muted-foreground" />}
        <span>{folder.name}</span>
      </button>
      {folder.children.map((child) => (
        <FolderOption
          key={child.id}
          folder={child}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
          canMoveTo={canMoveTo}
        />
      ))}
    </>
  );
}

export function DockerMoveToFolderDialog({
  open,
  onOpenChange,
  folders,
  currentFolderId,
  onMove,
  canMoveTo = allowEveryDestination,
}: DockerMoveToFolderDialogProps) {
  const [selected, setSelected] = useState<string | null>(currentFolderId);
  const displayedCurrentFolderId = useRetainedDialogValue(currentFolderId, open);

  useEffect(() => {
    if (open) setSelected(currentFolderId);
  }, [open, currentFolderId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to Folder</DialogTitle>
          <DialogDescription>
            Select a destination folder or move to root (ungrouped).
          </DialogDescription>
        </DialogHeader>
        <div className="border border-border">
          <button
            type="button"
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent transition-colors",
              selected === null && "bg-accent",
              "disabled:pointer-events-none disabled:opacity-50"
            )}
            disabled={!canMoveTo(null)}
            onClick={() => setSelected(null)}
          >
            <span className="font-medium">Root (ungrouped)</span>
          </button>
          {folders.map((folder) => (
            <FolderOption
              key={folder.id}
              folder={folder}
              depth={0}
              selected={selected}
              onSelect={setSelected}
              canMoveTo={canMoveTo}
            />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onMove(selected);
              onOpenChange(false);
            }}
            disabled={selected === displayedCurrentFolderId || !canMoveTo(selected)}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
