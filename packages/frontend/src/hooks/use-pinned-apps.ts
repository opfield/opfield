import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { APPS_LIST_CACHE_KEY } from "@/services/api-apps";
import { usePinnedAppsStore } from "@/stores/pinned-apps";
import type { AppSummary } from "@/types";

/**
 * The pinned apps the caller may still see, in pin order, from the server's app list (cached like the Apps page):
 * an app that was deleted or is no longer visible simply doesn't show.
 */
export function usePinnedApps(place: "dashboard" | "sidebar"): AppSummary[] {
  const ids = usePinnedAppsStore((s) =>
    place === "dashboard" ? s.dashboardAppIds : s.sidebarAppIds
  );
  const [apps, setApps] = useState<AppSummary[]>(
    () => api.getCached<AppSummary[]>(APPS_LIST_CACHE_KEY) ?? []
  );
  const wanted = ids.length > 0;
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    api
      .cachedRequest(APPS_LIST_CACHE_KEY, () => api.listApps())
      .then((list) => {
        if (!cancelled) setApps(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wanted]);
  const byId = new Map(apps.map((app) => [app.id, app]));
  return ids.flatMap((id) => {
    const app = byId.get(id);
    return app ? [app] : [];
  });
}
