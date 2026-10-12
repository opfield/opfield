import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  value: string;
  label: string;
  className?: string;
  iconClassName?: string;
}

function copyWithLegacyCommand(value: string): void {
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.padding = "0";
  textarea.style.border = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);

  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
    previouslyFocused?.focus({ preventScroll: true });
  }

  if (!copied) throw new Error("Clipboard access is unavailable");
}

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some embedded browsers expose Clipboard API but reject writes. Fall back
      // to the browser's legacy copy command while we are still in the click event.
    }
  }

  copyWithLegacyCommand(value);
}

export function CopyButton({ value, label, className, iconClassName }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const handleCopy = async () => {
    try {
      await copyToClipboard(value);
      setCopied(true);
      toast.success("Copied");
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        "relative shrink-0 rounded-none bg-header text-muted-foreground hover:bg-muted hover:text-foreground",
        className
      )}
      onClick={() => void handleCopy()}
      aria-label={`Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
    >
      <Check
        className={cn(
          "absolute transition-all duration-200",
          iconClassName,
          copied ? "scale-100 opacity-100" : "scale-0 opacity-0"
        )}
      />
      <Copy
        className={cn(
          "transition-all duration-200",
          iconClassName,
          copied ? "scale-0 opacity-0" : "scale-100 opacity-100"
        )}
      />
    </Button>
  );
}
