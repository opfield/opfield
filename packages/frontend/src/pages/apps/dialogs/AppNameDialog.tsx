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
import { Textarea } from "@/components/ui/textarea";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";

/** One width for every Apps dialog. */
export const APP_DIALOG_WIDTH = "sm:max-w-lg";

/** App description: one line under the name, up to 200 characters (the backend limit). */
export const APP_DESCRIPTION_MAX = 200;

/** A name form: New App (with an optional description), New Environment, Rename Environment. */
export function AppNameDialog({
  open,
  onOpenChange,
  title,
  description,
  initialName = "",
  placeholder,
  submitLabel,
  withDescription = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initialName?: string;
  placeholder?: string;
  submitLabel: string;
  /** Adds an optional Description field (New App). */
  withDescription?: boolean;
  /** Throw to keep the dialog open (the caller shows the error). `description` is trimmed, empty when not given. */
  onSubmit: (name: string, description: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [descriptionText, setDescriptionText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const shownTitle = useRetainedDialogValue(title, open);
  const shownDescription = useRetainedDialogValue(description, open);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setDescriptionText("");
      setSubmitting(false);
    }
  }, [open, initialName]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed, withDescription ? descriptionText.trim() : "");
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
        </DialogHeader>
        <DialogDescription>{shownDescription}</DialogDescription>
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
        {withDescription && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="app-name-dialog-description">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="app-name-dialog-description"
              value={descriptionText}
              onChange={(event) =>
                setDescriptionText(event.target.value.slice(0, APP_DESCRIPTION_MAX))
              }
              placeholder="What this app is"
              rows={2}
              maxLength={APP_DESCRIPTION_MAX}
              className="resize-none"
            />
          </div>
        )}
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
