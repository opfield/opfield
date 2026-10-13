import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { AppDetail } from "@/types";
import { AppNameDialog } from "./AppNameDialog";

/** New App: the empty state's and the list header's action. An app is its own resource. */
export function NewAppDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (app: AppDetail) => void;
}) {
  const scopes = useAuthStore((state) => state.user?.scopes);
  const folders = useResourceFolderStore((state) => state.foldersByType.app);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.app);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const [folderId, setFolderId] = useState("");
  // Same rule as POST /apps: broad apps:create allows any folder, folder grants only theirs.
  const folderChoices = useMemo(
    () => getCreateFolderChoices(scopes ?? [], "apps:create", folders),
    [folders, scopes]
  );

  useEffect(() => {
    if (!open) return;
    setFolderId("");
    void fetchFolders("app");
  }, [fetchFolders, open]);

  // A caller limited to folders starts in the first one they may create in.
  useEffect(() => {
    if (open && !folderId && !folderChoices.allowRoot && folderChoices.folders[0]) {
      setFolderId(folderChoices.folders[0].id);
    }
  }, [folderChoices, folderId, open]);

  return (
    <AppNameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New App"
      description="Group the containers, databases, storage, routes and Pages of one application. Create or import them from the app's tabs."
      placeholder="Shop"
      submitLabel="Create"
      withDescription
      submitDisabled={!isCreateFolderAllowed(folderChoices, folderId)}
      onSubmit={async (name, description) => {
        try {
          const app = await api.createApp({
            name,
            ...(description ? { description } : {}),
            folderId: folderId || null,
          });
          toast.success(`App ${app.name} created`);
          onCreated(app);
        } catch (error) {
          toastApiError(error, "Failed to create the app");
          throw error;
        }
      }}
    >
      {(folderChoices.folders.length > 0 || !folderChoices.allowRoot) && (
        <div className="space-y-1.5">
          <label htmlFor="new-app-folder" className="text-sm font-medium">
            Folder
          </label>
          <CreateFolderSelect
            id="new-app-folder"
            choices={folderChoices}
            value={folderId}
            onChange={setFolderId}
            loading={foldersLoading}
          />
        </div>
      )}
    </AppNameDialog>
  );
}
