import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "framer-motion";
import {
  CircleAlert,
  Folder,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RelativeTime } from "@/components/common/RelativeTime";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AIConversationFolder, AIConversationSummary } from "@/services/ai-conversations";
import { AIConversationStatusIndicator } from "./AIConversationStatusIndicator";

export interface SidebarPointerPosition {
  x: number;
  y: number;
}

export type FolderDialogState =
  | { mode: "create"; name: string; description: string }
  | { mode: "edit"; folderId: string; name: string; description: string };

export function ConversationFolderDialog({
  open,
  state,
  onOpenChange,
  onCreate,
  onUpdate,
}: {
  open: boolean;
  state: FolderDialogState;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, description: string) => Promise<void>;
  onUpdate: (folderId: string, name: string, description: string) => Promise<void>;
}) {
  const [draftName, setDraftName] = useState(state.name);
  const [draftDescription, setDraftDescription] = useState(state.description);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canSubmit = draftName.trim().length > 0;

  useEffect(() => {
    setDraftName(state.name);
    setDraftDescription(state.description);
    setIsSubmitting(false);
  }, [state]);

  const submit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      if (state.mode === "create") {
        await onCreate(draftName.trim(), draftDescription.trim());
      } else {
        await onUpdate(state.folderId, draftName.trim(), draftDescription.trim());
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{state.mode === "create" ? "New Project" : "Edit Project"}</DialogTitle>
          <DialogDescription>Group related Work Sessions in a sidebar project.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="ai-folder-name" className="text-sm font-medium text-foreground">
              Name
            </label>
            <Input
              id="ai-folder-name"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Project name"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="ai-folder-description" className="text-sm font-medium text-foreground">
              Description
            </label>
            <Textarea
              id="ai-folder-description"
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              placeholder="Optional description"
              className="min-h-20 resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={isSubmitting} disabled={!canSubmit}>
            {state.mode === "create" ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FolderMenuItem({
  folder,
  conversations,
  expanded,
  onToggle,
  onEdit,
  onDelete,
}: {
  folder: AIConversationFolder;
  conversations: AIConversationSummary[];
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: folder.id,
    data: { type: "folder", folderId: folder.id },
  });
  const StatusIcon = getFolderStatusIcon(conversations, expanded);
  const statusClassName = cn(
    "h-4 w-4 shrink-0",
    StatusIcon === Loader2
      ? "animate-spin text-primary"
      : StatusIcon === CircleAlert
        ? "text-warning-foreground"
        : ""
  );

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group flex max-w-full items-center overflow-hidden whitespace-nowrap text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        isDragging && "opacity-60"
      )}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden px-3 py-2 pr-1 text-left text-sm"
        onClick={onToggle}
      >
        <StatusIcon className={statusClassName} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{folder.name}</span>
          {folder.description.trim() && (
            <span className="truncate text-xs font-normal text-muted-foreground">
              {folder.description}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{conversations.length}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-sidebar-accent-foreground"
            aria-label={`Folder actions for ${folder.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onClick={onDelete}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function RootConversationDropZone({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: "conversation-root",
    data: { type: "root", folderId: null },
  });
  return (
    <div ref={setNodeRef} className={cn("min-h-2 space-y-0.5", isOver && "bg-sidebar-accent/50")}>
      {children}
    </div>
  );
}

export function DraggableConversationMenuItem({
  conversation,
  folderId,
  active,
  pinned,
  disableLayoutAnimation,
  hoverSyncRevision,
  pointerPositionRef,
  onLoad,
  onTogglePin,
  onDelete,
}: {
  conversation: AIConversationSummary;
  folderId: string | null;
  active: boolean;
  pinned: boolean;
  disableLayoutAnimation?: boolean;
  hoverSyncRevision: number;
  pointerPositionRef: { current: SidebarPointerPosition | null };
  onLoad: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `conversation:${conversation.id}`,
    data: { type: "conversation", conversationId: conversation.id, folderId },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(isDragging && "opacity-60")}
      {...attributes}
      {...listeners}
    >
      <ConversationMenuItem
        conversation={conversation}
        active={active}
        pinned={pinned}
        disableLayoutAnimation={disableLayoutAnimation}
        hoverSyncRevision={hoverSyncRevision}
        pointerPositionRef={pointerPositionRef}
        onLoad={onLoad}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />
    </div>
  );
}

export function ConversationDragOverlayItem({
  conversation,
  width,
}: {
  conversation: AIConversationSummary;
  width: number;
}) {
  return (
    <div
      style={{ width }}
      className="flex max-w-[calc(100vw-2rem)] items-center gap-3 overflow-hidden whitespace-nowrap border border-sidebar-border bg-sidebar-background px-3 py-2 text-sm font-medium text-sidebar-foreground shadow-lg"
    >
      <AIConversationStatusIndicator conversation={conversation} />
      <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
    </div>
  );
}

export function ConversationMenuItem({
  conversation,
  active,
  pinned,
  disableLayoutAnimation,
  hoverSyncRevision,
  pointerPositionRef,
  onLoad,
  onTogglePin,
  onDelete,
}: {
  conversation: AIConversationSummary;
  active: boolean;
  pinned: boolean;
  disableLayoutAnimation?: boolean;
  hoverSyncRevision: number;
  pointerPositionRef: { current: SidebarPointerPosition | null };
  onLoad: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const hoverSyncRevisionRef = useRef(hoverSyncRevision);
  const [isHovered, setIsHovered] = useState(false);
  useLayoutEffect(() => {
    if (hoverSyncRevisionRef.current === hoverSyncRevision) return;
    hoverSyncRevisionRef.current = hoverSyncRevision;
    const frameId = window.requestAnimationFrame(() => {
      const row = rowRef.current;
      const pointer = pointerPositionRef.current;
      if (!row || !pointer) {
        setIsHovered(false);
        return;
      }
      const bounds = row.getBoundingClientRect();
      const hoveredAfterListUpdate =
        pointer.x >= bounds.left &&
        pointer.x <= bounds.right &&
        pointer.y >= bounds.top &&
        pointer.y <= bounds.bottom;
      setIsHovered((current) =>
        current === hoveredAfterListUpdate ? current : hoveredAfterListUpdate
      );
    });
    return () => window.cancelAnimationFrame(frameId);
  });

  return (
    <div
      ref={rowRef}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        "group flex max-w-full items-center overflow-hidden whitespace-nowrap transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden px-3 py-2 pr-1 text-left text-sm"
        onClick={onLoad}
      >
        <AIConversationStatusIndicator conversation={conversation} />
        <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
      </button>
      <motion.div
        layout={!disableLayoutAnimation}
        className="mr-2 flex h-6 shrink-0 items-center justify-end overflow-hidden"
        transition={{ duration: 0.16, ease: "easeOut" }}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {isHovered ? (
            <motion.div
              key="actions"
              layout={!disableLayoutAnimation}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              className="flex items-center gap-0.5"
            >
              <button
                type="button"
                aria-label={`${pinned ? "Unpin" : "Pin"} ${conversation.title}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-sidebar-accent-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  onTogglePin();
                }}
              >
                {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                aria-label={`Delete ${conversation.title}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  if (event.detail > 0) {
                    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
                  }
                  onDelete();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          ) : (
            <motion.span
              key="time"
              layout={!disableLayoutAnimation}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              className="text-xs text-muted-foreground"
            >
              <RelativeTime value={conversation.lastUserMessageAt ?? conversation.createdAt} />
            </motion.span>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

export function getFolderStatusIcon(conversations: AIConversationSummary[], expanded: boolean) {
  if (
    conversations.some(
      (conversation) =>
        conversation.activeRunStatus === "waiting_for_approval" ||
        conversation.activeRunStatus === "waiting_for_answer" ||
        conversation.activeRunStatus === "waiting_for_credential" ||
        conversation.activeRunStatus === "waiting_for_setup" ||
        conversation.planStatus === "awaiting_decision" ||
        conversation.planStatus === "paused"
    )
  ) {
    return CircleAlert;
  }
  if (
    conversations.some(
      (conversation) =>
        conversation.activeRunStatus === "queued" || conversation.activeRunStatus === "running"
    )
  ) {
    return Loader2;
  }
  return expanded ? FolderOpen : Folder;
}
