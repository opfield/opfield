import { ChevronRight, Folder, type LucideIcon } from "lucide-react";
import type * as React from "react";
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

/** Any folder tree the picker shows. */
export interface MoveToFolderNode {
  id: string;
  name: string;
  children: MoveToFolderNode[];
}

interface MoveToFolderDialogProps<TFolder extends MoveToFolderNode> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: TFolder[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
  /** Destinations the caller may move into (defaults to every folder and the root). */
  canMoveTo?: (folderId: string | null) => boolean;
  /** Hint after the folder name, for example "3 routes". */
  describeFolder?: (folder: TFolder) => string;
  title?: string;
  description?: string;
  /** The top destination: the root (null), or the folder that works as the caller's root. */
  root?: { id: string | null; label: string };
}

const allowEveryDestination = () => true;
const TOP_LEVEL = { id: null, label: "Root (ungrouped)" };

/** One selectable destination of a "Move to …" picker (folders, apps). */
export function MoveDestinationRow({
  label,
  icon: Icon,
  strong = false,
  selected,
  disabled = false,
  depth = 0,
  hasChildren = false,
  hint,
  onSelect,
}: {
  label: React.ReactNode;
  icon?: LucideIcon;
  /** The top destination ("Root (ungrouped)", "No app"). */
  strong?: boolean;
  selected: boolean;
  disabled?: boolean;
  depth?: number;
  hasChildren?: boolean;
  /** Hint after the name, for example "3 routes". */
  hint?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    // Selectable tree row, not an action button.
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent transition-colors disabled:pointer-events-none disabled:opacity-50",
        selected && "bg-accent"
      )}
      style={depth > 0 ? { paddingLeft: `${depth * 20 + 12}px` } : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      {hasChildren && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
      {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      <span className={cn(strong && "font-medium")}>{label}</span>
      {hint ? <span className="text-xs text-muted-foreground ml-auto">{hint}</span> : null}
    </button>
  );
}

function FolderOption<TFolder extends MoveToFolderNode>({
  folder,
  depth,
  selected,
  onSelect,
  canMoveTo,
  describeFolder,
}: {
  folder: TFolder;
  depth: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  canMoveTo: (folderId: string | null) => boolean;
  describeFolder?: (folder: TFolder) => string;
}) {
  return (
    <>
      <MoveDestinationRow
        label={folder.name}
        icon={Folder}
        selected={selected === folder.id}
        disabled={!canMoveTo(folder.id)}
        depth={depth}
        hasChildren={folder.children.length > 0}
        hint={describeFolder?.(folder)}
        onSelect={() => onSelect(folder.id)}
      />
      {folder.children.map((child) => (
        <FolderOption
          key={child.id}
          folder={child as TFolder}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
          canMoveTo={canMoveTo}
          describeFolder={describeFolder}
        />
      ))}
    </>
  );
}

export function MoveToFolderDialog<TFolder extends MoveToFolderNode>({
  open,
  onOpenChange,
  folders,
  currentFolderId,
  onMove,
  canMoveTo = allowEveryDestination,
  describeFolder,
  title = "Move to Folder",
  description = "Select a destination folder or move to root (ungrouped).",
  root = TOP_LEVEL,
}: MoveToFolderDialogProps<TFolder>) {
  const [selected, setSelected] = useState<string | null>(currentFolderId);
  const displayedCurrentFolderId = useRetainedDialogValue(currentFolderId, open);

  useEffect(() => {
    if (open) setSelected(currentFolderId);
  }, [open, currentFolderId]);

  const handleMove = () => {
    onMove(selected);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="border border-border">
          <MoveDestinationRow
            label={root.label}
            strong
            selected={selected === root.id}
            disabled={!canMoveTo(root.id)}
            onSelect={() => setSelected(root.id)}
          />
          {folders.map((folder) => (
            <FolderOption
              key={folder.id}
              folder={folder}
              depth={0}
              selected={selected}
              onSelect={setSelected}
              canMoveTo={canMoveTo}
              describeFolder={describeFolder}
            />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleMove}
            disabled={selected === displayedCurrentFolderId || !canMoveTo(selected)}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
