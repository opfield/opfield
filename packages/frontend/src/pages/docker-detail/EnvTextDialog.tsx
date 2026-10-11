import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `KEY=value` lines to entries, split at the first `=`; blank lines are skipped. */
export function parseEnvText(text: string) {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const separator = line.indexOf("=");
      return separator >= 0
        ? { key: line.slice(0, separator), value: line.slice(separator + 1) }
        : { key: line, value: "" };
    });
}

/** 1-based lines whose name is missing, invalid or repeated. */
export function envTextErrorLines(text: string) {
  const errors = new Set<number>();
  const lines = new Map<string, number[]>();
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const separator = line.indexOf("=");
    const key = separator >= 0 ? line.slice(0, separator) : line;
    if (separator < 1 || !VARIABLE_NAME.test(key)) {
      errors.add(index + 1);
      return;
    }
    lines.set(key, [...(lines.get(key) ?? []), index + 1]);
  });
  for (const numbers of lines.values()) {
    if (numbers.length > 1) for (const number of numbers) errors.add(number);
  }
  return [...errors].sort((left, right) => left - right);
}

/**
 * Edits a set of variables as `KEY=value` lines in a modal. The table it came from stays in
 * place: Apply hands the text back to be parsed into the table's draft, Cancel discards it.
 * The caller owns the text, marks the invalid lines and decides whether they block Apply.
 */
export function EnvTextDialog({
  open,
  onOpenChange,
  title,
  description,
  value,
  onValueChange,
  errorLines,
  applyDisabled,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  /** 1-based lines shown as invalid. */
  errorLines: number[];
  applyDisabled: boolean;
  onApply: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <CodeEditor
          value={value}
          onChange={onValueChange}
          language="env"
          errorLines={errorLines}
          height="min(46dvh, 380px)"
          minHeight="220px"
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={applyDisabled} onClick={onApply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
