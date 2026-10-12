import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AppEnvironmentFields,
  allowedNodesHint,
  NoAllowedNodeNotice,
} from "@/components/apps/AppEnvironmentFields";
import {
  APP_FOLDER_CHOICES,
  type AppCreateContext,
  allowedAppNodes,
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useDialogPresence,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api-error-toast";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { PageProject, PageProjectPlacementOption } from "@/types";
import { PAGE_HOME_NODE_HINT } from "./page-format";

const usableNode = (node: PageProjectPlacementOption) =>
  node.status === "online" && node.pagesCapable;

/**
 * Create Page Project. With `appContext` (opened from an app): locked App field, environment
 * select, only the environment's allowed nginx nodes, created in the environment's folder.
 */
export function CreatePageProjectDialog({
  open,
  onOpenChange,
  onCreated,
  appContext,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: PageProject) => void;
  appContext?: AppCreateContext;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [placementOptions, setPlacementOptions] = useState<PageProjectPlacementOption[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesLoaded, setNodesLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const folders = useResourceFolderStore((state) => state.foldersByType["pages-project"]);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType["pages-project"]);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const scopes = useAuthStore((state) => state.user?.scopes);
  const { environment, environmentId, setEnvironmentId } = useAppEnvironmentChoice(
    appContext,
    open
  );
  // From an app: only the nginx nodes the environment allows.
  const nodes = useMemo(
    () => (appContext ? allowedAppNodes(environment, placementOptions) : placementOptions),
    [appContext, environment, placementOptions]
  );
  const usableNodes = useMemo(() => nodes.filter(usableNode), [nodes]);
  const appNodeLocked = !!appContext && nodes.length === 1;
  const noAllowedNode = !!appContext && !!environment && nodesLoaded && nodes.length === 0;
  const placementFolderId = appContext ? appPlacementFolderId(environment, "pages") : null;
  // Same rule as POST /pages/projects: broad or node grants allow any folder, folder grants only theirs.
  const folderChoices = useMemo(
    () =>
      appContext
        ? APP_FOLDER_CHOICES
        : getCreateFolderChoices(scopes ?? [], "pages:create", folders, nodeId || undefined),
    [appContext, folders, nodeId, scopes]
  );
  const destinationAllowed = appContext
    ? canCreateInFolder(scopes ?? [], "pages:create", placementFolderId, nodeId || undefined)
    : isCreateFolderAllowed(folderChoices, folderId);

  const present = useDialogPresence(open);
  useEffect(() => {
    if (open) {
      if (!appContext) void fetchFolders("pages-project");
      setNodesLoading(true);
      void api
        .listPageProjectPlacementOptions()
        .then((next) => setPlacementOptions(next))
        .catch((error) => toastApiError(error, "Failed to load Pages nodes"))
        .finally(() => {
          setNodesLoading(false);
          setNodesLoaded(true);
        });
    }
  }, [appContext, fetchFolders, open]);

  useEffect(() => {
    if (present) return;
    setName("");
    setDescription("");
    setNodeId("");
    setFolderId("");
    setSaving(false);
    setNodesLoaded(false);
  }, [present]);

  // From an app: the only allowed node is the home node; a node the environment does not allow
  // is dropped when the environment changes.
  useEffect(() => {
    if (!appContext || !nodesLoaded) return;
    if (appNodeLocked) {
      const only = nodes[0]!;
      if (usableNode(only) && nodeId !== only.id) setNodeId(only.id);
    } else if (nodeId && !nodes.some((node) => node.id === nodeId)) {
      setNodeId("");
    }
  }, [appContext, appNodeLocked, nodeId, nodes, nodesLoaded]);

  const submit = async () => {
    if (!name.trim() || !nodeId || saving || !destinationAllowed || noAllowedNode) return;
    setSaving(true);
    try {
      const project = await api.createPageProject({
        name: name.trim(),
        description: description.trim() || null,
        nodeId,
        folderId: (appContext ? placementFolderId : folderId) || null,
      });
      toast.success("Page Project created");
      rememberAppCreation(appContext, environment);
      onCreated(project);
      onOpenChange(false);
    } catch (error) {
      toastApiError(error, "Failed to create Page Project");
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Page Project</DialogTitle>
        </DialogHeader>
        <DialogDescription>Create a static site project for webhook deployments.</DialogDescription>
        <div className="space-y-4">
          {appContext && (
            <AppEnvironmentFields
              context={appContext}
              environmentId={environmentId}
              onEnvironmentChange={setEnvironmentId}
              hint={`Opened from ${appContext.app.name}. Only nginx nodes allowed in the environment are offered.`}
              disabled={saving}
            />
          )}
          {noAllowedNode && appContext && environment ? (
            <NoAllowedNodeNotice
              context={appContext}
              environment={environment}
              nodeKind="nginx"
              resourceKind="Pages projects"
              onNavigate={() => onOpenChange(false)}
            />
          ) : (
            <>
              <div className="space-y-1.5">
                <label htmlFor="page-project-name" className="text-sm font-medium">
                  Project name
                </label>
                <Input
                  id="page-project-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="page-project-folder" className="text-sm font-medium">
                  Folder
                </label>
                <CreateFolderSelect
                  id="page-project-folder"
                  choices={folderChoices}
                  value={appContext ? "" : folderId}
                  onChange={setFolderId}
                  loading={!appContext && foldersLoading}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="page-project-node" className="text-sm font-medium">
                  Home node
                </label>
                <Select
                  value={nodeId}
                  onValueChange={setNodeId}
                  disabled={nodesLoading || appNodeLocked}
                >
                  <SelectTrigger id="page-project-node" aria-label="Home node">
                    <SelectValue placeholder={nodesLoading ? "Loading nodes…" : "Select a node"} />
                  </SelectTrigger>
                  <SelectContent>
                    {nodes.map((node) => (
                      <SelectItem key={node.id} value={node.id} disabled={!usableNode(node)}>
                        {node.displayName || node.hostname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {appContext && environment
                    ? allowedNodesHint(environment, nodes.length, "nginx")
                    : PAGE_HOME_NODE_HINT}
                </p>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="page-project-description" className="text-sm font-medium">
                  Description
                </label>
                <Input
                  id="page-project-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Optional context for this static site"
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              !name.trim() ||
              !nodeId ||
              saving ||
              !destinationAllowed ||
              noAllowedNode ||
              (!!appContext && !usableNodes.some((node) => node.id === nodeId))
            }
          >
            {saving ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
