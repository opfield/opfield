import { CopyButton } from "@/components/common/CopyButton";
import { cn } from "@/lib/utils";

interface CopyCodeBlockProps {
  label: string;
  value: string;
  copyValue?: string;
  className?: string;
  codeClassName?: string;
}

export function CopyCodeBlock({
  label,
  value,
  copyValue = value,
  className,
  codeClassName,
}: CopyCodeBlockProps) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2.25rem] overflow-hidden border border-border bg-background">
        <div
          className={cn(
            "min-h-20 overflow-x-auto whitespace-pre px-3 py-2 text-sm text-foreground",
            codeClassName
          )}
        >
          {value}
        </div>
        <div className="border-l border-border bg-muted">
          <CopyButton value={copyValue} label={label} iconClassName="h-3.5 w-3.5" />
        </div>
      </div>
    </div>
  );
}
