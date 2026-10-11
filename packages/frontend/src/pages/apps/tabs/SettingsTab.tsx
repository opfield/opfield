// Settings: the app's name and app-wide maintenance, its environments and the danger zone
// (canvas frames app-settings, app-maintenance-on, app-env-new, app-access-code).
// Danger zone: Shut down / Start, the kill switch and Delete App (frames app-shutdown, app-stopped,
// app-kill, app-isolated).
import {
  AppWindow,
  KeyRound,
  Layers,
  Play,
  Plus,
  Power,
  ShieldAlert,
  ShieldOff,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  canEndIncidents,
  openAppIncidents,
  startAfterShutdown,
  turnOffKillSwitch,
} from "@/components/apps/app-incidents";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { appEnvironmentRoute, appRoute, appsRoute } from "@/lib/app-routes";
import { api } from "@/services/api";
import type { AppDetail, AppEnvironmentDetail } from "@/types";
import {
  EnvLink,
  MoreMenu,
  memberTotal,
  orderedEnvironments,
  plural,
  RowMenu,
} from "../app-shared";
import { DeleteAppDialog } from "../dialogs/DeleteAppDialog";
import { canOperateApp } from "../dialogs/incident-scope";
import { KillSwitchDialog } from "../dialogs/KillSwitchDialog";
import { RenameEnvironmentDialog } from "../dialogs/RenameEnvironmentDialog";
import { ShutdownDialog } from "../dialogs/ShutdownDialog";

export function SettingsTab({
  app,
  onChanged,
  onNewEnvironment,
  onCreateAccessCode,
  routeCount,
}: {
  app: AppDetail;
  onChanged: (app?: AppDetail) => void;
  onNewEnvironment: () => void;
  onCreateAccessCode: (environmentId?: string) => void;
  /** Routes of the app the user can see (the override's description). */
  routeCount: number | null;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(app.name);
  const [saving, setSaving] = useState(false);
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [renaming, setRenaming] = useState<AppEnvironmentDetail | null>(null);
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
  const canManageAnyEnv = Object.values(permissions.envManage).some(Boolean);

  useEffect(() => setName(app.name), [app.name]);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === app.name) return;
    setSaving(true);
    try {
      const next = await api.updateApp(app.id, { name: trimmed });
      toast.success("App renamed");
      onChanged(next);
      if (next.slug !== app.slug) navigate(appRoute(next.slug, "settings"), { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rename the app");
    } finally {
      setSaving(false);
    }
  };

  const setOverride = async (enabled: boolean) => {
    if (enabled) {
      const ok = await confirm({
        title: "Maintenance for the Whole App",
        description:
          "Every route of every environment returns the maintenance page (HTTP 503) until you turn it off. Each environment's own switch is kept and applies again afterwards.",
        confirmLabel: "Turn On",
      });
      if (!ok) return;
    }
    setOverrideSaving(true);
    try {
      const next = await api.updateApp(app.id, { maintenanceOverride: enabled });
      toast.success(enabled ? "Maintenance on for the whole app" : "App maintenance off");
      onChanged(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update maintenance");
    } finally {
      setOverrideSaving(false);
    }
  };

  const markProduction = async (env: AppEnvironmentDetail) => {
    const ok = await confirm({
      title: `Mark ${env.name} as Production`,
      description: `The app's health then follows ${env.name}. Only one environment is Production.`,
      confirmLabel: "Mark as Production",
    });
    if (!ok) return;
    try {
      await api.updateAppEnvironment(app.id, env.id, { isProduction: true });
      toast.success(`${env.name} is now Production`);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to mark as production");
    }
  };

  const deleteEnvironment = async (env: AppEnvironmentDetail) => {
    const members = memberTotal(env.memberCounts);
    const ok = await confirm({
      title: `Delete ${env.name}`,
      description:
        members > 0
          ? `Its ${plural(members, "resource")} keep running and leave the app. Its variables, secrets and allowed nodes are deleted.`
          : "Its variables, secrets and allowed nodes are deleted.",
      confirmLabel: "Delete Environment",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteAppEnvironment(app.id, env.id);
      toast.success(`Environment ${env.name} deleted`);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete the environment");
    }
  };

  return (
    <div className="space-y-4 pb-6">
      {(permissions.edit || permissions.operate || canManageAnyEnv) && (
        <PanelShell
          title="General"
          icon={<AppWindow className="h-4 w-4" />}
          description="Name and app-wide maintenance"
          actions={
            <>
              {permissions.edit && (
                <Button
                  onClick={() => void saveName()}
                  pending={saving}
                  disabled={!name.trim() || name.trim() === app.name}
                >
                  Save
                </Button>
              )}
              {(permissions.edit || permissions.operate) && (
                <MoreMenu label="More app actions">
                  <DropdownMenuItem onClick={() => onCreateAccessCode()}>
                    <KeyRound className="h-4 w-4" />
                    Create Maintenance Access Code
                  </DropdownMenuItem>
                </MoreMenu>
              )}
            </>
          }
        >
          <SettingsControlRow title="Name" description="Shown in Apps and in the search">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Name"
              disabled={!permissions.edit}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Maintenance for the whole app"
            description={
              routeCount === null
                ? "Every route, overriding each environment"
                : `All ${plural(routeCount, "route")}, overriding each environment`
            }
          >
            <div className="flex items-center gap-3">
              <Badge variant={app.maintenanceOverride ? "warning" : "secondary"} size="inline">
                {app.maintenanceOverride ? "All routes" : "Off"}
              </Badge>
              <Switch
                checked={app.maintenanceOverride}
                onChange={(enabled) => void setOverride(enabled)}
                disabled={!permissions.operate || overrideSaving}
                ariaLabel="Maintenance for the whole app"
              />
            </div>
          </SettingsControlRow>
        </PanelShell>
      )}

      <PanelShell
        title="Environments"
        icon={<Layers className="h-4 w-4" />}
        description="Groups of resources inside the app"
        actions={
          permissions.edit ? (
            <Button onClick={onNewEnvironment}>
              <Plus className="h-3.5 w-3.5" />
              New environment
            </Button>
          ) : undefined
        }
      >
        {orderedEnvironments(app.environments).map((env) => (
          <SettingsControlRow
            key={env.id}
            title={<EnvLink appSlug={app.slug} env={env} />}
            description={`${plural(memberTotal(env.memberCounts), "resource")} · ${env.health}`}
          >
            <RowMenu label={`Actions for ${env.name}`}>
              <DropdownMenuItem onClick={() => navigate(appEnvironmentRoute(app.slug, env.slug))}>
                Open
              </DropdownMenuItem>
              {permissions.edit && (
                <>
                  <DropdownMenuItem onClick={() => setRenaming(env)}>Rename</DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={env.isProduction}
                    onClick={() => void markProduction(env)}
                  >
                    Mark as production
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    disabled={env.isProduction}
                    onClick={() => void deleteEnvironment(env)}
                  >
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </RowMenu>
          </SettingsControlRow>
        ))}
      </PanelShell>

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
                <Button variant="outline" onClick={() => setShutdownOpen(true)}>
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
            <SettingsControlRow title="Delete App" description="Resources keep running">
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" />
                Delete App
              </Button>
            </SettingsControlRow>
          )}
        </PanelShell>
      )}

      <RenameEnvironmentDialog
        app={app}
        env={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={() => onChanged()}
      />
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
        onDeleted={() => navigate(appsRoute(), { replace: true })}
      />
    </div>
  );
}
