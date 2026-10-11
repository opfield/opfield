import { MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The row menu of a list without one of its own: Open and "Move to app...". */
export function MoveToAppRowMenu({
  resourceLabel,
  onOpen,
  onMoveToApp,
}: {
  /** Names the menu button for screen readers ("<label> actions"). */
  resourceLabel: string;
  onOpen?: () => void;
  onMoveToApp: () => void;
}) {
  return (
    // The row opens the resource on click; the menu must not.
    <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`${resourceLabel} actions`}>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onOpen && (
            <>
              <DropdownMenuItem onClick={onOpen}>Open</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={onMoveToApp}>Move to app...</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
