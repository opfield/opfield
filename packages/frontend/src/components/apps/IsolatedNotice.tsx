// The kill switch banner on the app page and on every member's page (canvas frames app-isolated,
// member-isolated): who isolated what and since when, items that are not applied or restored yet,
// and Turn off for whoever may operate the app.
import { ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Notice, NoticeAction } from "@/components/common/Notice";
import { useRealtime } from "@/hooks/use-realtime";
import { formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import {
  APPS_REALTIME_CHANNEL,
  type AppDetail,
  type AppMembershipRef,
  type AppsChangedPayload,
} from "@/types";
import { canEndIncidents, openAppIncidents, turnOffKillSwitch } from "./app-incidents";

const FAILED = new Set(["failed", "restore_failed"]);
const MAX_LISTED = 5;

export function IsolatedNotice({
  app,
  environmentIds,
  onChanged,
}: {
  app: AppDetail;
  /** Only these environments (a member's page); every environment of the app otherwise. */
  environmentIds?: readonly string[];
  onChanged?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const incidents = openAppIncidents(app, "isolation", environmentIds);
  if (incidents.length === 0) return null;

  const first = [...incidents].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]!;
  const releasing = incidents.every((incident) => incident.state === "releasing");
  const isolatedEnvs = app.environments.filter((env) =>
    incidents.some((incident) => incident.environmentId === env.id)
  );
  const scope =
    !environmentIds &&
    isolatedEnvs.length === app.environments.length &&
    app.environments.length > 1
      ? `All environments of ${app.name}`
      : `${isolatedEnvs.map((env) => env.name).join(", ")} of ${app.name}`;
  const failures = incidents.flatMap((incident) =>
    incident.items.filter((item) => FAILED.has(item.status))
  );
  const by = first.startedBy?.name ? ` by ${first.startedBy.name}` : "";
  const turnOff = async () => {
    setPending(true);
    try {
      if (await turnOffKillSwitch(app, incidents)) onChanged?.();
    } finally {
      setPending(false);
    }
  };

  return (
    <Notice
      tone="destructive"
      icon={ShieldAlert}
      title={
        releasing
          ? "Turning off the app kill switch"
          : `Isolated by the app kill switch since ${formatDateTime(first.startedAt)}${by}`
      }
      actions={
        !releasing && canEndIncidents(app, incidents) ? (
          <NoticeAction tone="destructive" onClick={() => void turnOff()} pending={pending}>
            Turn off
          </NoticeAction>
        ) : undefined
      }
    >
      {releasing
        ? `${scope}: everything the kill switch changed is being restored.`
        : `${scope}: routes show the maintenance page without a bypass, container links and database and storage bindings are cut, containers have no network access.`}
      {failures.length > 0 && (
        <span className="mt-1 block">
          {`${failures.length} ${failures.length === 1 ? "item is" : "items are"} not ${releasing ? "restored" : "applied"} yet and retried: `}
          {failures
            .slice(0, MAX_LISTED)
            .map((item) => `${item.label}${item.lastError ? ` (${item.lastError})` : ""}`)
            .join("; ")}
          {failures.length > MAX_LISTED ? "; …" : ""}
        </span>
      )}
    </Notice>
  );
}

/**
 * The app of a member (when the caller may view it), kept current through the apps realtime channel.
 * Null outside apps or without view permission on the app.
 */
export function useMemberApp(ref: AppMembershipRef | null | undefined): {
  app: AppDetail | null;
  reload: () => void;
} {
  const [app, setApp] = useState<AppDetail | null>(null);
  const appId = ref?.id ?? null;
  const appIdRef = useRef(appId);
  appIdRef.current = appId;

  const load = useCallback(async () => {
    if (!appId) {
      setApp(null);
      return;
    }
    try {
      setApp(await api.getApp(appId));
    } catch {
      // No view permission on the app (or it is gone).
      setApp(null);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(APPS_REALTIME_CHANNEL, (raw) => {
    const payload = raw as AppsChangedPayload;
    if (appIdRef.current && payload?.appId === appIdRef.current) void load();
  });

  const reload = useCallback(() => void load(), [load]);
  return { app: ref ? app : null, reload };
}

/**
 * The open incident of a member's environment that refuses changes to the member: only the kill
 * switch while it is applying or active. A shutdown holds nothing (members stay editable; Start skips
 * the ones deleted meanwhile). Null when there is none (or the app is not visible: the server still
 * refuses).
 */
export function memberIncidentBlock(
  app: AppDetail | null,
  ref: AppMembershipRef | null | undefined
): "isolation" | null {
  if (!app || !ref) return null;
  const isolated = openAppIncidents(app, "isolation", [ref.environmentId]).some(
    (incident) => incident.state === "applying" || incident.state === "active"
  );
  return isolated ? "isolation" : null;
}

/** Why an action the kill switch of a member's environment refuses is disabled, or null. */
export function memberIncidentReason(block: "isolation" | null): string | null {
  return block === "isolation"
    ? "Unavailable while the app kill switch isolates this environment."
    : null;
}

/**
 * What a member's page disables while the kill switch isolates its environment (the server refuses
 * the same with 409 APP_ISOLATED, see AppMemberFreeze): `frozen` for changes, `kept` for deleting the
 * member, removing its links and bindings, and renaming it. A shutdown disables neither. Null when the
 * action is allowed.
 */
export interface MemberIncidentHold {
  frozen: string | null;
  kept: string | null;
}

export function memberIncidentHold(
  app: AppDetail | null,
  ref: AppMembershipRef | null | undefined
): MemberIncidentHold {
  const reason = memberIncidentReason(memberIncidentBlock(app, ref));
  return { frozen: reason, kept: reason };
}

/**
 * The member's app and what its open incident disables on the member's page, for pages that render
 * the kill switch banner themselves (MemberIsolatedNotice with `app`).
 */
export function useMemberIncidentHold(ref: AppMembershipRef | null | undefined): {
  app: AppDetail | null;
  reload: () => void;
  hold: MemberIncidentHold;
} {
  const { app, reload } = useMemberApp(ref);
  return { app, reload, hold: memberIncidentHold(app, ref) };
}

/**
 * The banner on a member's own page: loads the member's app (when the caller may view it) and shows
 * the kill switch of the member's environment. A page that already loaded the app (useMemberApp or
 * useMemberIncidentHold) passes it as `memberApp` with its `onChanged` reload.
 */
export function MemberIsolatedNotice({
  app: ref,
  memberApp,
  onChanged,
}: {
  app: AppMembershipRef | null | undefined;
  memberApp?: AppDetail | null;
  onChanged?: () => void;
}) {
  if (memberApp !== undefined) {
    if (!ref || !memberApp) return null;
    return (
      <IsolatedNotice app={memberApp} environmentIds={[ref.environmentId]} onChanged={onChanged} />
    );
  }
  return <LoadedMemberIsolatedNotice app={ref} />;
}

function LoadedMemberIsolatedNotice({ app: ref }: { app: AppMembershipRef | null | undefined }) {
  const { app, reload } = useMemberApp(ref);
  if (!ref || !app) return null;
  return <IsolatedNotice app={app} environmentIds={[ref.environmentId]} onChanged={reload} />;
}
