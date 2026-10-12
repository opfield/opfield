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
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { ContentLoading } from "@/components/common/ContentLoading";
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
import { toastApiError } from "@/lib/api-error-toast";
import { databaseRoute } from "@/lib/resource-routes";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { DatabaseConnection } from "@/types";
import {
  buildDatabasePayload,
  canCreateDatabase,
  type DatabaseConnectionDraft,
  DatabaseConnectionForm,
  draftFromConnection,
} from "../database-detail/DatabaseConnectionForm";

/**
 * Add Database (connect an existing database). With `appContext` (opened from an app): locked
 * App field and environment select, no node, created in the environment's folder; without
 * `onCreated` it opens the new connection.
 */
export function DatabaseConnectionCreateDialog({
  open,
  onOpenChange,
  appContext,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appContext?: AppCreateContext;
  onCreated?: (database: DatabaseConnection) => void;
}) {
  const navigate = useNavigate();
  const userScopes = useAuthStore((state) => state.user?.scopes);
  const databaseFolders = useResourceFolderStore((state) => state.foldersByType.database);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.database);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const { environment, environmentId, setEnvironmentId } = useAppEnvironmentChoice(
    appContext,
    open
  );
  const [draft, setDraft] = useState<DatabaseConnectionDraft>(draftFromConnection(null));
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  // Same destination rule as the create route: folder-scoped creators only get their folders.
  const folderChoices = useMemo(
    () =>
      appContext
        ? APP_FOLDER_CHOICES
        : getCreateFolderChoices(userScopes ?? [], "databases:create", databaseFolders),
    [appContext, databaseFolders, userScopes]
  );
  const placementFolderId = appContext ? appPlacementFolderId(environment, "databases") : null;
  const destinationAllowed = appContext
    ? canCreateInFolder(userScopes ?? [], "databases:create", placementFolderId)
    : isCreateFolderAllowed(folderChoices, folderId);
  const loadingFolders = !appContext && foldersLoading;

  useEffect(() => {
    if (open && !appContext) void fetchFolders("database");
  }, [appContext, fetchFolders, open]);

  const save = async () => {
    setSaving(true);
    try {
      const created = await api.createDatabase({
        ...buildDatabasePayload(draft),
        folderId: (appContext ? placementFolderId : folderId) || null,
      });
      toast.success("Database connection created");
      rememberAppCreation(appContext, environment);
      onOpenChange(false);
      setDraft(draftFromConnection(null));
      setFolderId("");
      if (onCreated) onCreated(created);
      else navigate(databaseRoute(created.slug, "overview"));
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to create database connection");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Database</DialogTitle>
        </DialogHeader>
        <AnimatedHeight>
          <ContentLoading loading={loadingFolders} />
          {appContext && (
            <div className="mb-4">
              <AppEnvironmentFields
                context={appContext}
                environmentId={environmentId}
                onEnvironmentChange={setEnvironmentId}
                hint={`Opened from ${appContext.app.name}. The connection is added to the environment.`}
                disabled={saving}
              />
            </div>
          )}
          <DatabaseConnectionForm
            draft={draft}
            onChange={setDraft}
            folderField={
              <div className="min-w-0 space-y-1.5">
                <label htmlFor="database-create-folder" className="text-sm font-medium">
                  Folder
                </label>
                <CreateFolderSelect
                  id="database-create-folder"
                  choices={folderChoices}
                  value={appContext ? "" : folderId}
                  onChange={setFolderId}
                  loading={loadingFolders}
                />
              </div>
            }
          />
        </AnimatedHeight>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            pending={saving}
            disabled={!canCreateDatabase(draft) || !destinationAllowed}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
