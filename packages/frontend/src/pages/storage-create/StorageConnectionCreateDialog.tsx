import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AppEnvironmentFields } from "@/components/apps/AppEnvironmentFields";
import {
  APP_FOLDER_CHOICES,
  type AppCreateContext,
  appPlacementFolderId,
  rememberAppCreation,
  useAppEnvironmentChoice,
} from "@/components/apps/app-create-context";
import { ContentLoading } from "@/components/common/ContentLoading";
import {
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastApiError } from "@/lib/api-error-toast";
import { storageRoute } from "@/lib/resource-routes";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { ObjectStorageConnection } from "@/types";
import {
  buildStoragePayload,
  draftFromConnection,
  type StorageConnectionDraft,
  StorageConnectionForm,
} from "../storage-detail/StorageConnectionForm";

/**
 * Add Storage (connect an existing endpoint). With `appContext` (opened from an app): locked App
 * field and environment select, no node, created in the environment's folder; without
 * `onCreated` it opens the new connection.
 */
export function StorageConnectionCreateDialog({
  open,
  onOpenChange,
  appContext,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appContext?: AppCreateContext;
  onCreated?: (storage: ObjectStorageConnection) => void;
}) {
  const navigate = useNavigate();
  const userScopes = useAuthStore((state) => state.user?.scopes);
  const storageFolders = useResourceFolderStore((state) => state.foldersByType.storage);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.storage);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const { environment, environmentId, setEnvironmentId } = useAppEnvironmentChoice(
    appContext,
    open
  );
  const [draft, setDraft] = useState<StorageConnectionDraft>(draftFromConnection(null));
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);
  // Same destination rule as the create route: folder-scoped creators only get their folders.
  const folderChoices = useMemo(
    () =>
      appContext
        ? APP_FOLDER_CHOICES
        : getCreateFolderChoices(userScopes ?? [], "storage:create", storageFolders),
    [appContext, storageFolders, userScopes]
  );
  const placementFolderId = appContext ? appPlacementFolderId(environment, "storage") : null;
  const destinationAllowed = appContext
    ? canCreateInFolder(userScopes ?? [], "storage:create", placementFolderId)
    : isCreateFolderAllowed(folderChoices, folderId);
  const loadingFolders = !appContext && foldersLoading;

  // Each opening starts at the root folder.
  useEffect(() => {
    if (!open) return;
    setFolderId("");
    if (!appContext) void fetchFolders("storage");
  }, [appContext, fetchFolders, open]);

  const save = async () => {
    setSaving(true);
    try {
      const created = await api.createObjectStorage({
        ...buildStoragePayload(draft),
        folderId: (appContext ? placementFolderId : folderId) || null,
      });
      toast.success("Storage connection created");
      rememberAppCreation(appContext, environment);
      onOpenChange(false);
      setDraft(draftFromConnection(null));
      if (onCreated) onCreated(created);
      else navigate(storageRoute(created.slug, "overview"));
    } catch (error) {
      toastApiError(error, "Failed to create storage connection");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Storage</DialogTitle>
          <DialogDescription>
            Connect an existing S3-compatible, FTP, FTPS, or SFTP endpoint.
          </DialogDescription>
        </DialogHeader>
        <ContentLoading loading={loadingFolders} />
        {appContext && (
          <AppEnvironmentFields
            context={appContext}
            environmentId={environmentId}
            onEnvironmentChange={setEnvironmentId}
            hint={`Opened from ${appContext.app.name}. The connection is added to the environment.`}
            disabled={saving}
          />
        )}
        <SettingsControlRow title="Folder" description="Organization folder">
          <CreateFolderSelect
            choices={folderChoices}
            value={appContext ? "" : folderId}
            onChange={setFolderId}
            loading={loadingFolders}
          />
        </SettingsControlRow>
        <StorageConnectionForm draft={draft} onChange={setDraft} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} pending={saving} disabled={!destinationAllowed}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
