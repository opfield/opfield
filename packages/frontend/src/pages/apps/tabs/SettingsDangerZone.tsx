// Settings danger zone: Shut down / Start, the kill switch and Delete App (canvas frames app-shutdown,
// app-stopped, app-kill, app-isolated).
import { Play, Power, ShieldAlert, ShieldOff, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  canEndIncidents,
  openAppIncidents,
  startAfterShutdown,
  turnOffKillSwitch,
} from "@/components/apps/app-incidents";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLeavePage } from "@/hooks/use-navigation-trail";
import { appRoute, appsRoute } from "@/lib/app-routes";
import type { AppDetail } from "@/types";
import { DeleteAppDialog } from "../dialogs/DeleteAppDialog";
import { canOperateApp, shutdownUnavailableReason } from "../dialogs/incident-scope";
import { KillSwitchDialog } from "../dialogs/KillSwitchDialog";
import { ShutdownDialog } from "../dialogs/ShutdownDialog";

export function SettingsDangerZone({
  app,
  onChanged,
}: {
  app: AppDetail;
  onChanged: (app?: AppDetail) => void;
}) {
  const leavePage = useLeavePage();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [ending, setEnding] = useState<"start" | "release" | null>(null);
  const { permissions } = app;
  const canOperate = canOperateApp(app);
  const stoppedIncidents = openAppIncidents(app, "shutdown");
  const isolatedIncidents = openAppIncidents(app, "isolation");
  const stopped = stoppedIncidents.length > 0;
  const isolated = isolatedIncidents.length > 0;
  // A shutdown on top of the kill switch is refused (409 APP_ISOLATED): turn the kill switch off first.
  const shutdownUnavailable = shutdownUnavailableReason(app);

  const start = async () => {
    setEnding("start");
    try {
      if (await startAfterShutdown(app, stoppedIncidents)) onChanged();
    } finally {
      setEnding(null);
    }
  };

  const release = async () => {
    setEnding("release");
    try {
      if (await turnOffKillSwitch(app, isolatedIncidents)) onChanged();
    } finally {
      setEnding(null);
    }
  };

  return (
    <>
      {(permissions.delete || canOperate) && (
        <PanelShell
          title="Danger zone"
          icon={<TriangleAlert className="h-4 w-4 text-destructive" />}
          description="Actions for the whole app or one environment"
          className="border-destructive/60"
        >
          {canOperate && (
            <SettingsControlRow
              title={
                <span className="inline-flex items-center gap-2">
                  Shut down
                  {stopped && (
                    <Badge variant="secondary" size="inline">
                      Stopped
                    </Badge>
                  )}
                </span>
              }
              description="Stop everything that runs; Start brings it back"
            >
              {stopped && canEndIncidents(app, stoppedIncidents) ? (
                <Button onClick={() => void start()} pending={ending === "start"}>
                  <Play className="h-4 w-4" />
                  Start
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => setShutdownOpen(true)}
                  disabled={shutdownUnavailable !== null}
                  title={shutdownUnavailable ?? undefined}
                >
                  <Power className="h-4 w-4" />
                  Shut down
                </Button>
              )}
            </SettingsControlRow>
          )}
          {canOperate && (
            <SettingsControlRow
              title={
                <span className="inline-flex items-center gap-2">
                  Kill switch
                  {isolated && (
                    <Badge variant="destructive" size="inline">
                      Isolated
                    </Badge>
                  )}
                </span>
              }
              description="Cut all traffic and isolate the app during an incident"
            >
              {isolated && canEndIncidents(app, isolatedIncidents) ? (
                <Button
                  variant="outline"
                  onClick={() => void release()}
                  pending={ending === "release"}
                >
                  <ShieldOff className="h-4 w-4" />
                  Turn off
                </Button>
              ) : (
                <Button variant="destructive" onClick={() => setKillOpen(true)}>
                  <ShieldAlert className="h-4 w-4" />
                  Isolate app
                </Button>
              )}
            </SettingsControlRow>
          )}
          {permissions.delete && (
            <SettingsControlRow title="Delete app" description="Resources keep running">
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" />
                Delete app
              </Button>
            </SettingsControlRow>
          )}
        </PanelShell>
      )}
      <ShutdownDialog
        app={app}
        open={shutdownOpen}
        onOpenChange={setShutdownOpen}
        onDone={() => onChanged()}
      />
      <KillSwitchDialog
        app={app}
        open={killOpen}
        onOpenChange={setKillOpen}
        onDone={() => onChanged()}
      />
      <DeleteAppDialog
        app={app}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => leavePage(appsRoute(), { gonePaths: [appRoute(app.slug)] })}
      />
    </>
  );
}
