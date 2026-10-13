import { useEffect } from "react";
import { useLeavePage } from "@/hooks/use-navigation-trail";

/**
 * Leaves a page whose resource is gone (deleted, or no longer visible): back to where it was
 * opened from, else to `fallback`. The declarative form of {@link useLeavePage}.
 */
export function LeavePageRedirect({
  fallback,
  gonePath,
}: {
  fallback: string;
  /** A path whose pages are gone too (an app with its environment pages). */
  gonePath?: string;
}) {
  const leavePage = useLeavePage();
  useEffect(() => {
    leavePage(fallback, gonePath ? { gonePaths: [gonePath] } : undefined);
  }, [fallback, gonePath, leavePage]);
  return null;
}
