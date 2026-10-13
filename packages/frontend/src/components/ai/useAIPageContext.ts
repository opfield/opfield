import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { type AIPageContext, resolveAIPageContext } from "@/lib/ai-page-context";
import { useResolvedPageContext } from "@/stores/resolved-page-context";

/** The current page as the AI assistant sees it; see AI_PAGE_ROUTES. */
export function useAIPageContext(): AIPageContext {
  const route = useLocation().pathname;
  const resolvedStatus = useResolvedPageContext((s) => s.status);
  const resolvedRouteKey = useResolvedPageContext((s) => s.routeKey);
  const resolvedResource = useResolvedPageContext((s) => s.resource);
  const ownsRoute =
    resolvedStatus === "ready" &&
    !!resolvedRouteKey &&
    (route === resolvedRouteKey || route.startsWith(`${resolvedRouteKey}/`));
  const published = ownsRoute ? resolvedResource : null;

  return useMemo(() => resolveAIPageContext(route, published), [route, published]);
}
