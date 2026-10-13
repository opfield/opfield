import { AppWindow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { MoveDestinationRow } from "@/components/common/MoveToFolderDialog";
import { Notice } from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type {
  AppDetail,
  AppEnvironmentDetail,
  AppPlaceMemberInput,
  AppPlaceRefusal,
} from "@/types";
import {
  environmentLabel,
  readLastAppEnvironment,
  rememberAppEnvironment,
} from "./app-create-context";

/**
 * Move to App (canvas frame move-to-app): "No app" + the apps the user may manage, then the
 * environment (last used / Production). Refused members are reported. Opened from a row menu of
 * a normal list (non-members) and from the app tabs (members).
 */
export interface MoveToAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One row or several. */
  members: AppPlaceMemberInput[];
  /** Name shown in the description ("Select an app for <label> …"). */
  resourceLabel: string;
  /** The member's current app (preselected; "No app" takes it out). */
  currentAppId?: string | null;
  onMoved?: () => void;
}

/** Environments of `app` the caller may place members into. */
export function manageableEnvironments(app: AppDetail): AppEnvironmentDetail[] {
  return app.environments.filter((env) => app.permissions.envManage[env.id] === true);
}

/** The environment to start with: the last used one, else Production, else the first. */
export function defaultMoveEnvironmentId(
  appId: string,
  environments: AppEnvironmentDetail[]
): string | null {
  const lastUsed = readLastAppEnvironment(appId);
  return (
    (
      environments.find((env) => env.id === lastUsed) ??
      environments.find((env) => env.isProduction) ??
      environments[0]
    )?.id ?? null
  );
}

/** One refused member as the dialog lists it. */
export function describeRefusal(
  refusal: AppPlaceRefusal,
  context: { environmentName?: string | null; nodeName?: string | null }
): string {
  if (refusal.code === "APP_NODE_NOT_ALLOWED" && context.environmentName) {
    return `${context.nodeName ? `Its node ${context.nodeName} is` : "Its node is"} not allowed in ${context.environmentName}; add it to the environment's allowed nodes first`;
  }
  return refusal.message || refusal.code;
}

interface ManageableApp {
  app: AppDetail;
  environments: AppEnvironmentDetail[];
}

/** Cached destinations; every `/apps` mutation clears the `apps:` prefix, so a placement refreshes them. */
const MOVE_TARGETS_CACHE_KEY = "apps:move-targets";
/** How long cached destinations are shown at once while the dialog refreshes them. */
const MOVE_TARGETS_SHOW_TTL_MS = 10 * 60_000;

let loadingManageableApps: Promise<ManageableApp[]> | null = null;

/** Apps with at least one environment the caller may manage; one load at a time. */
function loadManageableApps(): Promise<ManageableApp[]> {
  loadingManageableApps ??= readManageableApps().finally(() => {
    loadingManageableApps = null;
  });
  return loadingManageableApps;
}

/** Apps with at least one environment the caller may manage (permissions come from the app). */
async function readManageableApps(): Promise<ManageableApp[]> {
  const summaries = await api.listApps();
  const details = await Promise.allSettled(summaries.map((summary) => api.getApp(summary.id)));
  const loaded = details.flatMap((result) => {
    if (result.status !== "fulfilled") return [];
    const environments = manageableEnvironments(result.value);
    return environments.length > 0 ? [{ app: result.value, environments }] : [];
  });
  api.setCache(MOVE_TARGETS_CACHE_KEY, loaded);
  return loaded;
}

const cachedManageableApps = () =>
  api.getCached<ManageableApp[]>(MOVE_TARGETS_CACHE_KEY, MOVE_TARGETS_SHOW_TTL_MS) ?? null;

export function MoveToAppDialog({
  open,
  onOpenChange,
  members: openMembers,
  resourceLabel: openResourceLabel,
  currentAppId = null,
  onMoved,
}: MoveToAppDialogProps) {
  // The rows stay on screen while the dialog closes.
  const members = useRetainedDialogValue(openMembers, open);
  const resourceLabel = useRetainedDialogValue(openResourceLabel, open);
  const [apps, setApps] = useState<ManageableApp[] | null>(cachedManageableApps);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(currentAppId);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [refused, setRefused] = useState<AppPlaceRefusal[]>([]);
  const [moving, setMoving] = useState(false);
  const nodes = useUIBootstrapStore((state) => state.snapshot?.navigation.nodes.data);

  // Load the destinations ahead, so the dialog opens with its list instead of loading it.
  useEffect(() => {
    if (!open && cachedManageableApps() === null) void loadManageableApps().catch(() => undefined);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSelectedAppId(currentAppId);
    setEnvironmentId(null);
    setRefused([]);
    // The cached list shows at once; the refresh replaces it in place.
    const cached = cachedManageableApps();
    setApps(cached);
    let cancelled = false;
    loadManageableApps()
      .then((loaded) => {
        if (!cancelled) setApps(loaded);
      })
      .catch((error) => {
        if (cancelled) return;
        if (cached === null) setApps([]);
        toastApiError(error, "Failed to load apps");
      });
    return () => {
      cancelled = true;
    };
  }, [currentAppId, open]);

  const selected = useMemo(
    () => apps?.find((entry) => entry.app.id === selectedAppId) ?? null,
    [apps, selectedAppId]
  );
  const environment = selected?.environments.find((env) => env.id === environmentId) ?? null;

  // A newly picked app starts at its last used environment, else Production.
  useEffect(() => {
    if (!selected) return;
    setEnvironmentId((current) =>
      current && selected.environments.some((env) => env.id === current)
        ? current
        : defaultMoveEnvironmentId(selected.app.id, selected.environments)
    );
  }, [selected]);

  const selectApp = (appId: string | null) => {
    setSelectedAppId(appId);
    setEnvironmentId(null);
    setRefused([]);
  };

  const nodeName = (nodeId: string | undefined) => {
    const node = nodeId ? nodes?.find((candidate) => candidate.id === nodeId) : undefined;
    return node ? node.displayName || node.hostname : null;
  };

  const memberName = (member: AppPlaceMemberInput) =>
    members.length === 1 ? resourceLabel : (member.resourceKey ?? member.id ?? member.type);

  const takesOut = selectedAppId === null;
  const canMove =
    !moving &&
    members.length > 0 &&
    (takesOut ? currentAppId !== null : selected !== null && environment !== null);

  const handleMove = async () => {
    if (!canMove) return;
    setMoving(true);
    setRefused([]);
    try {
      const result = await api.placeAppMembers({
        target:
          selected && environment
            ? { appId: selected.app.id, environmentId: environment.id }
            : null,
        members,
      });
      if (selected && environment) rememberAppEnvironment(selected.app.id, environment.id);
      const destination =
        selected && environment ? `${selected.app.name} · ${environment.name}` : null;
      if (result.placed > 0) {
        const moved = members.length === 1 ? resourceLabel : `${result.placed} resources`;
        toast.success(
          destination ? `Moved ${moved} to ${destination}` : `Took ${moved} out of apps`
        );
        onMoved?.();
      }
      if (result.refused.length > 0) {
        setRefused(result.refused);
        return;
      }
      onOpenChange(false);
    } catch (error) {
      toastApiError(error, "Failed to move to the app");
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move to App</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Select an app for {resourceLabel} or take it out of apps.
        </DialogDescription>
        {/* The list and the environment field grow in place when they arrive. */}
        <AnimatedHeight>
          <div className="space-y-4">
            <div className="border border-border">
              <MoveDestinationRow
                label="No app"
                strong
                selected={takesOut}
                onSelect={() => selectApp(null)}
              />
              {apps === null ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">Loading apps…</p>
              ) : apps.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  No app where you can manage members.
                </p>
              ) : (
                apps.map(({ app }) => (
                  <MoveDestinationRow
                    key={app.id}
                    label={app.name}
                    icon={AppWindow}
                    selected={selectedAppId === app.id}
                    onSelect={() => selectApp(app.id)}
                  />
                ))
              )}
            </div>
            {selected && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="move-to-app-environment">
                  Environment
                </label>
                <Select
                  value={environmentId ?? ""}
                  onValueChange={(value) => {
                    setEnvironmentId(value);
                    setRefused([]);
                  }}
                >
                  <SelectTrigger id="move-to-app-environment" aria-label="Environment">
                    <SelectValue placeholder="Select an environment" />
                  </SelectTrigger>
                  <SelectContent>
                    {selected.environments.map((env) => (
                      <SelectItem key={env.id} value={env.id}>
                        {environmentLabel(env)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {refused.length > 0 && (
              <Notice
                tone="warning"
                title={
                  refused.length >= members.length
                    ? "Nothing was moved"
                    : `${refused.length} of ${members.length} were not moved`
                }
              >
                <ul className="space-y-1">
                  {refused.map((refusal, index) => (
                    <li
                      key={`${refusal.member.type}:${refusal.member.id ?? refusal.member.resourceKey ?? index}`}
                    >
                      {memberName(refusal.member)}:{" "}
                      {describeRefusal(refusal, {
                        environmentName: environment?.name,
                        nodeName: nodeName(refusal.member.nodeId),
                      })}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>
        </AnimatedHeight>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleMove()} disabled={!canMove} pending={moving}>
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
