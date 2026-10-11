import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ExternalComposeBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="warning" size="inline" className="shrink-0">
          External
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top">
        Discovered on the Docker node but not managed by Opfield. Adopt it to manage revisions and
        lifecycle actions.
      </TooltipContent>
    </Tooltip>
  );
}
