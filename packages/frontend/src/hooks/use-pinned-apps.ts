import { useCallback, useEffect, useState } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { APPS_LIST_CACHE_KEY } from "@/services/api-apps";
import { usePinnedAppsStore } from "@/stores/pinned-apps";
import { APPS_REALTIME_CHANNEL, type AppSummary } from "@/types";

/** One app list request shared by the sidebar and the dashboard when an app changes. */
let loading: Promise<AppSummary[]> | null = null;

function loadApps(): Promise<AppSummary[]> {
  loading ??= api
    .listApps()
    .then((list) => {
      api.setCache(APPS_LIST_CACHE_KEY, list);
      return list;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * The pinned apps the caller may still see, in pin order, from the server's app list (cached like the Apps page):
 * an app that was deleted or is no longer visible simply doesn't show. Any app change (a new logo, a rename, its
 * health, a deletion) reloads the list.
 */
export function usePinnedApps(place: "dashboard" | "sidebar"): AppSummary[] {
  const ids = usePinnedAppsStore((s) =>
    place === "dashboard" ? s.dashboardAppIds : s.sidebarAppIds
  );
  const [apps, setApps] = useState<AppSummary[]>(
    () => api.getCached<AppSummary[]>(APPS_LIST_CACHE_KEY) ?? []
  );
  const wanted = ids.length > 0;
  const reload = useCallback(() => {
    let cancelled = false;
    loadApps()
      .then((list) => {
        if (!cancelled) setApps(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (wanted) return reload();
  }, [wanted, reload]);
  useRealtime(wanted ? APPS_REALTIME_CHANNEL : null, () => void reload(), {
    onReconnect: () => void reload(),
  });
  const byId = new Map(apps.map((app) => [app.id, app]));
  return ids.flatMap((id) => {
    const app = byId.get(id);
    return app ? [app] : [];
  });
}
