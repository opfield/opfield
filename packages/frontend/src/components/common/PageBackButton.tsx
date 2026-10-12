import { ArrowLeft } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { useBackNavigation } from "@/hooks/use-navigation-trail";
import { cn } from "@/lib/utils";

type PageBackButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label?: string;
  /**
   * Go to the page the user came from inside the console (default). Set false for back controls
   * with a fixed destination; a `returnTo` link state is still honoured.
   */
  followTrail?: boolean;
};

/**
 * Page back arrow: returns to the previous console page of this tab's navigation trail, then to
 * a `returnTo` link state, and otherwise runs `onClick` (the page's logical parent).
 */
export function PageBackButton({
  className,
  onClick,
  label = "Back",
  followTrail = true,
  ...props
}: PageBackButtonProps) {
  const { goBack } = useBackNavigation();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("h-9 w-9 shrink-0", className)}
      aria-label={label}
      title={label}
      onClick={(event) => {
        if (goBack({ followTrail })) return;
        onClick?.(event);
      }}
      {...props}
    >
      <ArrowLeft className="h-4 w-4" />
    </Button>
  );
}
