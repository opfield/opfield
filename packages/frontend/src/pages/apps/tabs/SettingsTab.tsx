// Settings: the app's name and app-wide maintenance, its environments and the danger zone
// (canvas frames app-settings, app-maintenance-on, app-env-new, app-access-code).
// Phase 1 danger zone: Delete App only (Shut down and the kill switch come with Phase 2).
import { AppWindow, KeyRound, Layers, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
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
import { RenameEnvironmentDialog } from "../dialogs/RenameEnvironmentDialog";

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
  const { permissions } = app;
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

      {permissions.delete && (
        <PanelShell
          title="Danger zone"
          icon={<TriangleAlert className="h-4 w-4 text-destructive" />}
          description="Actions for the whole app"
          className="border-destructive/60"
        >
          <SettingsControlRow title="Delete App" description="Resources keep running">
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-4 w-4" />
              Delete App
            </Button>
          </SettingsControlRow>
        </PanelShell>
      )}

      <RenameEnvironmentDialog
        app={app}
        env={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={() => onChanged()}
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
