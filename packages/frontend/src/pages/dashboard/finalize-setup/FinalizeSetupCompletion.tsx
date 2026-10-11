import { Check } from "lucide-react";
import type { ReactNode } from "react";

export function FinalizeSetupCompletion({
  title,
  children,
  continueIn,
}: {
  title: string;
  children: ReactNode;
  continueIn: string;
}) {
  return (
    <div className="space-y-3 border border-border p-4">
      <div className="flex items-center gap-3">
        <Check className="h-5 w-5 shrink-0 text-success-text" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{children}</p>
        </div>
      </div>
      <p className="border-t border-border pt-3 text-sm text-muted-foreground">{continueIn}</p>
    </div>
  );
}
