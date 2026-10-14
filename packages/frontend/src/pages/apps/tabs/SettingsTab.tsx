// Settings: the app's logo, name, description, allowed domains and app-wide maintenance, its
// environments and the danger zone (canvas frames app-settings, app-maintenance-on, app-env-new,
// app-access-code; the danger zone is in SettingsDangerZone).
import { AppWindow, ImageUp, KeyRound, Layers, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AppMark } from "@/components/apps/AppMark";
import { AvatarCropDialog } from "@/components/common/AvatarCropDialog";
import { confirm } from "@/components/common/ConfirmDialog";
import { EditableStringList } from "@/components/common/EditableStringList";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api-error-toast";
import { appEnvironmentRoute, appRoute } from "@/lib/app-routes";
import { api } from "@/services/api";
import type { AppDetail, AppEnvironmentDetail } from "@/types";
import {
  EnvLabel,
  MoreMenu,
  memberTotal,
  orderedEnvironments,
  plural,
  RowMenu,
} from "../app-shared";
import { RenameEnvironmentDialog } from "../dialogs/RenameEnvironmentDialog";
import {
  DOMAIN_PATTERN_PLACEHOLDER,
  domainPatternDraft,
  sameDomainPatterns,
} from "../domain-patterns";
import { SettingsDangerZone } from "./SettingsDangerZone";

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
  const [description, setDescription] = useState(app.description ?? "");
  const [domainPatterns, setDomainPatterns] = useState<string[]>(app.domainPatterns ?? []);
  const [saving, setSaving] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [renaming, setRenaming] = useState<AppEnvironmentDetail | null>(null);
  const { permissions } = app;
  const canManageAnyEnv = Object.values(permissions.envManage).some(Boolean);

  useEffect(() => setName(app.name), [app.name]);
  useEffect(() => setDescription(app.description ?? ""), [app.description]);
  useEffect(() => setDomainPatterns(app.domainPatterns ?? []), [app.domainPatterns]);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const nameChanged = trimmedName !== app.name;
  const descriptionChanged = trimmedDescription !== (app.description ?? "");
  const nextDomainPatterns = domainPatternDraft(domainPatterns);
  const domainPatternsChanged = !sameDomainPatterns(nextDomainPatterns, app.domainPatterns ?? []);
  const generalChanged = nameChanged || descriptionChanged || domainPatternsChanged;

  const saveGeneral = async () => {
    if (!trimmedName || !generalChanged) return;
    setSaving(true);
    try {
      const next = await api.updateApp(app.id, {
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(descriptionChanged ? { description: trimmedDescription || null } : {}),
        ...(domainPatternsChanged ? { domainPatterns: nextDomainPatterns } : {}),
      });
      toast.success(nameChanged ? "App renamed" : "App updated");
      onChanged(next);
      if (next.slug !== app.slug) navigate(appRoute(next.slug, "settings"), { replace: true });
    } catch (error) {
      toastApiError(error, "Failed to update the app");
    } finally {
      setSaving(false);
    }
  };

  const updateLogo = async (logo: Blob | null) => {
    setLogoUploading(true);
    try {
      const next = await api.updateAppLogo(app.id, logo);
      toast.success(logo ? "Logo updated" : "Logo removed");
      onChanged(next);
      return true;
    } catch (error) {
      toastApiError(error, "Failed to update the logo");
      return false;
    } finally {
      setLogoUploading(false);
    }
  };

  const chooseLogoFile = (file: File | undefined) => {
    if (!file) return;
    if (!SUPPORTED_LOGO_TYPES.has(file.type)) {
      toast.error("Choose a PNG, JPEG, or WebP image");
      return;
    }
    if (file.size > MAX_LOGO_SOURCE_BYTES) {
      toast.error("Choose an image no larger than 25 MiB");
      return;
    }
    setLogoFile(file);
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
      toastApiError(error, "Failed to update maintenance");
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
      toastApiError(error, "Failed to mark as production");
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
      toastApiError(error, "Failed to delete the environment");
    }
  };

  return (
    <div className="space-y-4 pb-6">
      {(permissions.edit || permissions.operate || canManageAnyEnv) && (
        <PanelShell
          title="General"
          icon={<AppWindow className="h-4 w-4" />}
          description="Name, logo, description, allowed domains and app-wide maintenance"
          dirty={permissions.edit && generalChanged}
          actions={
            <>
              {(permissions.edit || permissions.operate) && (
                <MoreMenu label="More app actions">
                  <DropdownMenuItem onClick={() => onCreateAccessCode()}>
                    <KeyRound className="h-4 w-4" />
                    Create Maintenance Access Code
                  </DropdownMenuItem>
                </MoreMenu>
              )}
              {permissions.edit && (
                <Button
                  onClick={() => void saveGeneral()}
                  pending={saving}
                  disabled={!trimmedName || !generalChanged}
                >
                  <Save />
                  Save
                </Button>
              )}
            </>
          }
        >
          <SettingsControlRow
            title="Logo"
            description="PNG, JPEG or WebP; you crop it to a square before it uploads"
          >
            <div className="flex items-center gap-2">
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                aria-label="Choose logo image"
                onChange={(event) => {
                  chooseLogoFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              {/* The logo itself is the control; its overlay shows the action. */}
              <button
                type="button"
                aria-label={app.logoUrl ? "Change logo" : "Upload logo"}
                className="group relative h-9 w-9 shrink-0 outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
                disabled={!permissions.edit || logoUploading}
                onClick={() => logoInputRef.current?.click()}
              >
                <AppMark logoUrl={app.logoUrl} size="sm" />
                {permissions.edit && (
                  <span className="absolute inset-0 flex items-center justify-center bg-scrim/60 text-on-scrim opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    <ImageUp className="h-4 w-4" />
                  </span>
                )}
              </button>
              {permissions.edit && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => logoInputRef.current?.click()}
                    disabled={logoUploading}
                  >
                    <ImageUp className="h-3.5 w-3.5" />
                    {app.logoUrl ? "Replace" : "Upload"}
                  </Button>
                  {app.logoUrl && (
                    <Button
                      variant="outline"
                      size="icon"
                      title="Remove logo"
                      aria-label="Remove logo"
                      disabled={logoUploading}
                      onClick={() => void updateLogo(null)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </>
              )}
            </div>
          </SettingsControlRow>
          <SettingsControlRow title="Name" description="Shown in Apps and in the search">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Name"
              disabled={!permissions.edit}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Description"
            description="Under the name in Apps and on the app's page"
          >
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value.slice(0, APP_DESCRIPTION_MAX))}
              aria-label="Description"
              placeholder="What this app is"
              rows={2}
              maxLength={APP_DESCRIPTION_MAX}
              className="resize-none"
              disabled={!permissions.edit}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Allowed domains"
            description="Domains every environment may use. Empty allows any domain"
          >
            {permissions.edit ? (
              <EditableStringList
                values={domainPatterns}
                onChange={setDomainPatterns}
                placeholder={DOMAIN_PATTERN_PLACEHOLDER}
                itemLabel="Allowed domain"
              />
            ) : (
              <span className="text-sm text-muted-foreground">
                {(app.domainPatterns ?? []).join(", ") || "Any domain"}
              </span>
            )}
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
            title={<EnvLabel env={env} />}
            onClick={() => navigate(appEnvironmentRoute(app.slug, env.slug))}
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

      <SettingsDangerZone app={app} onChanged={onChanged} />

      {/* close-reset-ok: AvatarCropDialog retains the file itself */}
      <AvatarCropDialog
        title="Adjust Logo"
        file={logoFile}
        open={logoFile !== null}
        uploading={logoUploading}
        onOpenChange={(open) => {
          if (!open) setLogoFile(null);
        }}
        onUpload={updateLogo}
      />
      <RenameEnvironmentDialog
        app={app}
        env={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={() => onChanged()}
      />
    </div>
  );
}

const APP_DESCRIPTION_MAX = 200;
const MAX_LOGO_SOURCE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
