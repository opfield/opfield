import { Pin, Play, Power, RefreshCw, ShieldAlert, ShieldOff, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  canEndIncidents,
  openAppIncidents,
  startAfterShutdown,
  turnOffKillSwitch,
} from "@/components/apps/app-incidents";
import {
  HEADER_ACTION_PRIORITY,
  type ResponsiveHeaderAction,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
import { SwitchCard } from "@/components/common/SwitchCard";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { appsRoute } from "@/lib/app-routes";
import { cn } from "@/lib/utils";
import { usePinnedAppsStore } from "@/stores/pinned-apps";
import type { AppDetail } from "@/types";
import { DeleteAppDialog } from "./dialogs/DeleteAppDialog";
import { canOperateApp, shutdownUnavailableReason } from "./dialogs/incident-scope";
import { KillSwitchDialog } from "./dialogs/KillSwitchDialog";
import { ShutdownDialog } from "./dialogs/ShutdownDialog";

/**
 * The App page header: Refresh, Pin, the New menu, Shut down or Start, the kill switch and Delete, like the
 * header of every other resource. Destructive actions go to the overflow menu.
 */
export function AppHeaderActions({
  app,
  refreshing,
  onRefresh,
  onChanged,
  newMenu,
}: {
  app: AppDetail;
  refreshing: boolean;
  onRefresh: () => void;
  onChanged: () => void;
  /** The New menu (create in the app), placed after Pin. */
  newMenu?: ReactNode;
}) {
  const navigate = useNavigate();
  const [pinOpen, setPinOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const pinnedDashboard = usePinnedAppsStore((s) => s.dashboardAppIds.includes(app.id));
  const pinnedSidebar = usePinnedAppsStore((s) => s.sidebarAppIds.includes(app.id));
  const { toggleDashboard, toggleSidebar } = usePinnedAppsStore();

  const canOperate = canOperateApp(app);
  const stoppedIncidents = openAppIncidents(app, "shutdown");
  const isolatedIncidents = openAppIncidents(app, "isolation");
  const canStart = stoppedIncidents.length > 0 && canEndIncidents(app, stoppedIncidents);
  const canRelease = isolatedIncidents.length > 0 && canEndIncidents(app, isolatedIncidents);
  const shutdownUnavailable = shutdownUnavailableReason(app);

  const end = async (run: () => Promise<boolean>) => {
    setEnding(true);
    try {
      if (await run()) onChanged();
    } finally {
      setEnding(false);
    }
  };

  const actions: ResponsiveHeaderAction[] = [
    {
      id: "app:refresh",
      label: "Refresh",
      icon: <RefreshCw className="h-4 w-4" />,
      onClick: onRefresh,
    },
    {
      id: "app:pin",
      label: "Pin app",
      icon: <Pin className="h-4 w-4" />,
      onClick: () => setPinOpen(true),
    },
    ...(canOperate
      ? [
          canStart
            ? {
                id: "app:start",
                label: "Start",
                icon: <Play className="h-4 w-4" />,
                onClick: () => void end(() => startAfterShutdown(app, stoppedIncidents)),
                disabled: ending,
                priority: HEADER_ACTION_PRIORITY.primary,
              }
            : {
                id: "app:shutdown",
                label: "Shut down",
                icon: <Power className="h-4 w-4" />,
                onClick: () => setShutdownOpen(true),
                disabled: shutdownUnavailable !== null,
                disabledReason: shutdownUnavailable ?? undefined,
                alwaysOverflow: true,
                separatorBefore: true,
              },
          canRelease
            ? {
                id: "app:release",
                label: "Turn off kill switch",
                icon: <ShieldOff className="h-4 w-4" />,
                onClick: () => void end(() => turnOffKillSwitch(app, isolatedIncidents)),
                disabled: ending,
                priority: HEADER_ACTION_PRIORITY.emergency,
              }
            : {
                id: "app:isolate",
                label: "Isolate app",
                icon: <ShieldAlert className="h-4 w-4" />,
                onClick: () => setKillOpen(true),
                destructive: true,
              },
        ]
      : []),
    // The New menu (create in the app) stays in the header: it is the page's main action.
    ...(newMenu
      ? [
          {
            id: "app:new",
            label: "New",
            onClick: () => undefined,
            priority: HEADER_ACTION_PRIORITY.emergency,
          },
        ]
      : []),
    ...(app.permissions.delete
      ? [
          {
            id: "app:delete",
            label: "Delete app",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: () => setDeleteOpen(true),
            destructive: true,
          },
        ]
      : []),
  ];

  return (
    <>
      {/* Each action has its button at the same index: the overflow menu takes what doesn't fit. */}
      <ResponsiveHeaderActions reservedContentWidth={360} actions={actions}>
        {actions.map((action) =>
          action.id === "app:new" ? (
            <span key={action.id}>{newMenu}</span>
          ) : (
            <Button
              key={action.id}
              variant={action.destructive ? "destructive" : "outline"}
              size={action.id === "app:refresh" || action.id === "app:pin" ? "icon" : "default"}
              aria-label={action.label}
              title={action.disabled ? action.disabledReason : action.label}
              disabled={action.disabled || (action.id === "app:refresh" && refreshing)}
              onClick={action.onClick}
            >
              {action.id === "app:refresh" ? (
                <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              ) : (
                action.icon
              )}
              {action.id === "app:refresh" || action.id === "app:pin" ? null : action.label}
            </Button>
          )
        )}
      </ResponsiveHeaderActions>

      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pin App</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <SwitchCard
              label="Add to dashboard"
              description="Show a compact health card on the dashboard"
              checked={pinnedDashboard}
              onCheckedChange={() => toggleDashboard(app.id)}
            />
            <SwitchCard
              label="Add to sidebar"
              description="Quick access link in the sidebar"
              checked={pinnedSidebar}
              onCheckedChange={() => toggleSidebar(app.id)}
            />
          </div>
        </DialogContent>
      </Dialog>
      <ShutdownDialog
        app={app}
        open={shutdownOpen}
        onOpenChange={setShutdownOpen}
        onDone={onChanged}
      />
      <KillSwitchDialog app={app} open={killOpen} onOpenChange={setKillOpen} onDone={onChanged} />
      <DeleteAppDialog
        app={app}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => {
          usePinnedAppsStore.getState().removePin(app.id);
          navigate(appsRoute(), { replace: true });
        }}
      />
    </>
  );
}
