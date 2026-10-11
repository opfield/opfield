import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ReferenceTableRow {
  /** The variable, helper usage or query syntax, shown in monospace. */
  term: string;
  description: ReactNode;
}

interface ReferenceTableProps {
  /** Heading of the term column, such as "Variable", "Usage" or "Syntax". */
  termLabel: string;
  descriptionLabel?: string;
  rows: readonly ReferenceTableRow[];
  /** Optional heading above the table. */
  title?: ReactNode;
  className?: string;
}

/** A compact two-column reference of template variables, helpers or query syntax. */
export function ReferenceTable({
  termLabel,
  descriptionLabel = "Description",
  rows,
  title,
  className,
}: ReferenceTableProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {title ? <h4 className="text-sm font-medium">{title}</h4> : null}
      <div className="overflow-hidden border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-header">
              <th scope="col" className="px-3 py-1.5 text-left font-medium">
                {termLabel}
              </th>
              <th scope="col" className="px-3 py-1.5 text-left font-medium">
                {descriptionLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.term} className="border-b border-border last:border-b-0">
                {/* Syntax highlighting: the colour template editors give variables. */}
                <td className="px-3 py-1.5 font-mono text-code-variable">{row.term}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{row.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
