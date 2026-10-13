import { useEffect, useMemo, useState } from "react";
import { AppEnvironmentFields } from "@/components/apps/AppEnvironmentFields";
import {
  type AppCreateContext,
  appPlacementFolderId,
  rememberAppCreation,
  useAppEnvironmentChoice,
} from "@/components/apps/app-create-context";
import {
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api-error-toast";
import { canCreateInFolder } from "@/lib/scope-utils";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { LoggingEnvironment } from "@/types";

/**
 * Create or edit a logging environment. With `appContext` (create opened from an app): locked App
 * field, environment choice, and the environment's placement folder instead of a folder choice.
 */
export function LoggingEnvironmentDialog({
  open,
  environment,
  onOpenChange,
  onSave,
  appContext,
}: {
  open: boolean;
  environment?: LoggingEnvironment | null;
  onOpenChange: (open: boolean) => void;
  onSave: (data: Partial<LoggingEnvironment>) => Promise<void>;
  appContext?: AppCreateContext;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const folders = useResourceFolderStore((state) => state.foldersByType["logging-environment"]);
  const foldersLoading = useResourceFolderStore(
    (state) => state.loadingByType["logging-environment"]
  );
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const scopes = useAuthStore((state) => state.user?.scopes);
  // Same destination rule as the create route: folder-scoped creators only see their folders.
  const folderChoices = useMemo(
    () => getCreateFolderChoices(scopes ?? [], "logs:environments:create", folders),
    [folders, scopes]
  );
  const app = useAppEnvironmentChoice(appContext, open);
  const placementFolderId = appContext ? appPlacementFolderId(app.environment, "logging") : null;
  const destinationAllowed =
    !!environment ||
    (appContext
      ? !!placementFolderId &&
        canCreateInFolder(scopes ?? [], "logs:environments:create", placementFolderId)
      : isCreateFolderAllowed(folderChoices, folderId));

  useEffect(() => {
    if (!open) return;
    setName(environment?.name ?? "");
    setDescription(environment?.description ?? "");
    setFolderId(environment?.folderId ?? "");
    if (!environment && !appContext) void fetchFolders("logging-environment");
  }, [appContext, environment, fetchFolders, open]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        name,
        description: description || null,
        ...(!environment ? { folderId: (appContext ? placementFolderId : folderId) || null } : {}),
        schemaMode: environment?.schemaMode ?? "loose",
        retentionDays: environment?.retentionDays ?? 30,
        fieldSchema: environment?.fieldSchema ?? [],
      });
      if (!environment) rememberAppCreation(appContext, app.environment);
      onOpenChange(false);
    } catch (error) {
      setSaving(false);
      if (!handleLicenseApiError(error, "Logging environments")) {
        toastApiError(error, "Failed to create logging environment");
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{environment ? "Edit Environment" : "Create Environment"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {appContext && !environment && (
            <AppEnvironmentFields
              context={appContext}
              environmentId={app.environmentId}
              onEnvironmentChange={app.setEnvironmentId}
              hint={`Opened from ${appContext.app.name}. The logging environment joins the environment.`}
              disabled={saving}
            />
          )}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production"
            />
          </label>
          {!environment && !appContext && (
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Folder</span>
              <CreateFolderSelect
                choices={folderChoices}
                value={folderId}
                onChange={setFolderId}
                loading={foldersLoading}
              />
            </label>
          )}
          {environment && (
            <p className="text-xs text-muted-foreground">
              Slug: <span className="font-mono">{environment.slug}</span>
            </p>
          )}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Description</span>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Application logs from production services"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            pending={saving}
            disabled={!name.trim() || !destinationAllowed}
            onClick={() => void save()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
