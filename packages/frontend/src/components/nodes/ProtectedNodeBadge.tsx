import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PROTECTED_NODE_DESCRIPTION } from "@/lib/node-host-access";

/** The Protected badge of a relay whose machine owner turned protected mode on, with what it means on hover. */
export function ProtectedNodeBadge({
  label = "Protected",
  size,
}: {
  label?: string;
  size?: "default" | "inline";
}) {
  return (
    <Tooltip>
      {/* A focusable tooltip trigger around the badge, not an action button. */}
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Badge variant="info" size={size}>
            {label}
          </Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-xs whitespace-normal py-2 leading-relaxed"
      >
        {PROTECTED_NODE_DESCRIPTION}
      </TooltipContent>
    </Tooltip>
  );
}
