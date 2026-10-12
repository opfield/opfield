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

/** One width for every Apps dialog. */
export const APP_DIALOG_WIDTH = "sm:max-w-lg";

/** A name-only form: New App, New Environment, Rename Environment. */
export function AppNameDialog({
  open,
  onOpenChange,
  title,
  description,
  initialName = "",
  placeholder,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initialName?: string;
  placeholder?: string;
  submitLabel: string;
  /** Throw to keep the dialog open (the caller shows the error). */
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const shownTitle = useRetainedDialogValue(title, open);
  const shownDescription = useRetainedDialogValue(description, open);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setSubmitting(false);
    }
  }, [open, initialName]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch {
      // The caller reported the error; the form stays open for a retry.
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={APP_DIALOG_WIDTH}>
        <DialogHeader>
          <DialogTitle>{shownTitle}</DialogTitle>
          <DialogDescription>{shownDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="app-name-dialog-name">
            Name
          </label>
          <Input
            id="app-name-dialog-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={placeholder}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={submitting} disabled={!name.trim()}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
