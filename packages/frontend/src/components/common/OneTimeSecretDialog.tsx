import type { ReactNode } from "react";
import { CopyValueField } from "@/components/common/CopyValueField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const ONE_TIME_SECRET_NOTICE = "Copy it now — it won't be shown again.";

export interface OneTimeSecretField {
  label: string;
  value: string;
  /** A short line under the field, e.g. when the value is only a fallback. */
  hint?: ReactNode;
}

interface OneTimeSecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "<Thing> Created". */
  title: ReactNode;
  /** What the secret is for; the one-time notice follows it. */
  description?: ReactNode;
  /** The secret values, each in a copy field. Null once the secret is dropped. */
  fields: OneTimeSecretField[] | null;
  /** Content shown above the fields, such as a setup command. */
  children?: ReactNode;
  /** Runs once the dialog has finished closing, to drop the secret from state. */
  onClosed?: () => void;
  className?: string;
}

/**
 * Shows a freshly created token, key or password once: the title, a
 * description that says it won't be shown again, the value in a copy field,
 * and Done.
 */
export function OneTimeSecretDialog({
  open,
  onOpenChange,
  title,
  description,
  fields,
  children,
  onClosed,
  className,
}: OneTimeSecretDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("sm:max-w-lg", className)}
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            onClosed?.();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {description ? <>{description} </> : null}
          {ONE_TIME_SECRET_NOTICE}
        </DialogDescription>
        <div className="min-w-0 space-y-4">
          {children}
          {fields?.map((field) => (
            <div key={field.label} className="space-y-1.5">
              <CopyValueField label={field.label} value={field.value} valueClassName="font-mono" />
              {field.hint ? <p className="text-xs text-muted-foreground">{field.hint}</p> : null}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
