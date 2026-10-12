import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { appDetailCacheKey } from "@/services/api-apps";
import { APPS_REALTIME_CHANNEL, type AppDetail, type AppsChangedPayload } from "@/types";

const MEMBER_RELOAD_DELAY_MS = 1_000;

/**
 * The app of an Apps page, by slug or id, kept current by the `apps` realtime channel and by the
 * channels of its members.
 * `version` bumps on every realtime change of this app so tabs can reload their rows.
 */
export function useAppDetail(idOrSlug: string | undefined, initial?: AppDetail | null) {
  const [app, setApp] = useState<AppDetail | null>(
    () =>
      initial ?? (idOrSlug ? (api.getCached<AppDetail>(appDetailCacheKey(idOrSlug)) ?? null) : null)
  );
  const [loading, setLoading] = useState(!app);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const appIdRef = useRef<string | null>(app?.id ?? null);

  const reload = useCallback(async () => {
    if (!idOrSlug) return;
    try {
      const next = await api.getApp(idOrSlug);
      appIdRef.current = next.id;
      api.setCache(appDetailCacheKey(idOrSlug), next);
      setApp(next);
      setError(null);
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  }, [idOrSlug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useRealtime(APPS_REALTIME_CHANNEL, (raw) => {
    const payload = raw as AppsChangedPayload;
    if (appIdRef.current && payload?.appId && payload.appId !== appIdRef.current) return;
    setVersion((current) => current + 1);
    void reload();
  });

  // A member's own changes (state, health, alerts, deployments) reach the app's pages too, like
  // every other page: a burst of events reloads once.
  const memberTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const memberChanged = useCallback(() => {
    if (memberTimer.current) return;
    memberTimer.current = setTimeout(() => {
      memberTimer.current = null;
      setVersion((current) => current + 1);
      void reload();
    }, MEMBER_RELOAD_DELAY_MS);
  }, [reload]);
  useEffect(
    () => () => {
      if (memberTimer.current) clearTimeout(memberTimer.current);
    },
    []
  );
  useRealtime("docker.container.changed", memberChanged, { onReconnect: memberChanged });
  useRealtime("docker.deployment.changed", memberChanged);
  useRealtime("docker.compose.changed", memberChanged);
  useRealtime("docker.health.changed", memberChanged);
  useRealtime("docker.availability.changed", memberChanged);
  useRealtime("database.changed", memberChanged);
  useRealtime("managed-storage.changed", memberChanged);
  useRealtime("proxy.host.changed", memberChanged);
  useRealtime("proxy.secure-link.changed", memberChanged);
  useRealtime("pages.project.changed", memberChanged);
  useRealtime("pages.deployment.changed", memberChanged);
  useRealtime("node.changed", memberChanged);
  useRealtime("alert.fired", memberChanged);
  useRealtime("alert.resolved", memberChanged);

  const refresh = useCallback(async () => {
    setVersion((current) => current + 1);
    await reload();
  }, [reload]);

  return { app, setApp, loading, error, version, refresh };
}
