import { useEffect, useMemo, useState } from "react";
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
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { LoggingEnvironment } from "@/types";

export function LoggingEnvironmentDialog({
  open,
  environment,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  environment?: LoggingEnvironment | null;
  onOpenChange: (open: boolean) => void;
  onSave: (data: Partial<LoggingEnvironment>) => Promise<void>;
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
  const destinationAllowed = !!environment || isCreateFolderAllowed(folderChoices, folderId);

  useEffect(() => {
    if (!open) return;
    setName(environment?.name ?? "");
    setDescription(environment?.description ?? "");
    setFolderId(environment?.folderId ?? "");
    if (!environment) void fetchFolders("logging-environment");
  }, [environment, fetchFolders, open]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        name,
        description: description || null,
        ...(!environment ? { folderId: folderId || null } : {}),
        schemaMode: environment?.schemaMode ?? "loose",
        retentionDays: environment?.retentionDays ?? 30,
        fieldSchema: environment?.fieldSchema ?? [],
      });
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
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production"
            />
          </label>
          {!environment && (
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
