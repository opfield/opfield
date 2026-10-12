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
import { Input } from "@/components/ui/input";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";

interface FolderNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  onSubmit: (name: string) => void | Promise<void>;
}

/** The folder name form shared by Create Folder and Rename Folder. */
function FolderNameDialog({
  open,
  onOpenChange,
  title,
  description,
  initialName,
  submitLabel,
  onSubmit,
}: FolderNameDialogProps) {
  const [name, setName] = useState(initialName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const displayedTitle = useRetainedDialogValue(title, open);
  const displayedDescription = useRetainedDialogValue(description, open);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setIsSubmitting(false);
    }
  }, [open, initialName]);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{displayedTitle}</DialogTitle>
        </DialogHeader>
        <DialogDescription>{displayedDescription}</DialogDescription>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          aria-label="Folder name"
          placeholder="Folder name"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            pending={isSubmitting}
            disabled={!name.trim()}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface FolderCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  initialName?: string;
  onCreate: (name: string) => void | Promise<void>;
}

export function FolderCreateDialog({
  open,
  onOpenChange,
  title = "Create Folder",
  description = "Enter a name for the new folder.",
  initialName = "",
  onCreate,
}: FolderCreateDialogProps) {
  return (
    <FolderNameDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      initialName={initialName}
      submitLabel="Create"
      onSubmit={onCreate}
    />
  );
}

interface FolderRenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The folder's current name; the field opens with it. */
  folderName: string;
  onRename: (name: string) => void | Promise<void>;
}

export function FolderRenameDialog({
  open,
  onOpenChange,
  folderName,
  onRename,
}: FolderRenameDialogProps) {
  return (
    <FolderNameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Rename Folder"
      description="Enter a new name for this folder."
      initialName={folderName}
      submitLabel="Save"
      onSubmit={onRename}
    />
  );
}
