import { ChevronDown, Container, Gitlab, Globe, Play, Plus, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { DockerRegistry, Node } from "@/types";

interface DockerRegistriesSectionProps {
  nodesList: Node[];
}

const GITLAB_REGISTRIES_EXPANDED_STORAGE_KEY = "opfield.dockerRegistries.gitlabExpanded";

function readGitLabRegistriesExpanded(): boolean | null {
  try {
    const stored = window.localStorage.getItem(GITLAB_REGISTRIES_EXPANDED_STORAGE_KEY);
    if (stored == null) return null;
    return stored === "true";
  } catch {
    return null;
  }
}

function writeGitLabRegistriesExpanded(expanded: boolean) {
  try {
    window.localStorage.setItem(GITLAB_REGISTRIES_EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    /* ignore */
  }
}

export function DockerRegistriesSection({ nodesList }: DockerRegistriesSectionProps) {
  const { hasScope } = useAuthStore();
  const canCreateRegistry = hasScope("docker:registries:create");
  const canEditRegistry = hasScope("docker:registries:edit");
  const canDeleteRegistry = hasScope("docker:registries:delete");
  const cachedRegistries = api.getCached<DockerRegistry[]>("settings:docker-registries");
  const [registries, setRegistries] = useState<DockerRegistry[]>(cachedRegistries ?? []);
  const [initialLoadComplete, setInitialLoadComplete] = useState(cachedRegistries !== undefined);
  const [regDialogOpen, setRegDialogOpen] = useState(false);
  const [regEditId, setRegEditId] = useState<string | null>(null);
  const [regName, setRegName] = useState("");
  const [regUrl, setRegUrl] = useState("");
  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regTrustedAuthRealm, setRegTrustedAuthRealm] = useState("");
  const [regScope, setRegScope] = useState<"global" | "node">("global");
  const [regNodeId, setRegNodeId] = useState("");
  const [regSaving, setRegSaving] = useState(false);
  const [regTesting, setRegTesting] = useState<string | null>(null);
  const [regDeleting, setRegDeleting] = useState<string | null>(null);
  const [gitLabRegistriesExpanded, setGitLabRegistriesExpanded] = useState<boolean | null>(
    readGitLabRegistriesExpanded
  );
  const manualRegistries = registries.filter((registry) => !registry.integration);
  const gitLabRegistries = registries.filter(
    (registry) => registry.integration?.provider === "gitlab"
  );
  const effectiveGitLabRegistriesExpanded =
    gitLabRegistriesExpanded ?? manualRegistries.length === 0;

  const loadRegistries = useCallback(async () => {
    try {
      const data = await api.listDockerRegistries();
      api.setCache("settings:docker-registries", data ?? []);
      setRegistries(data ?? []);
    } catch {
      /* ignore */
    } finally {
      setInitialLoadComplete(true);
    }
  }, []);

  useEffect(() => {
    loadRegistries();
  }, [loadRegistries]);

  useRealtime("docker.registry.changed", () => {
    loadRegistries();
  });

  const toggleGitLabRegistriesExpanded = () => {
    const next = !effectiveGitLabRegistriesExpanded;
    writeGitLabRegistriesExpanded(next);
    setGitLabRegistriesExpanded(next);
  };

  const openRegCreate = () => {
    setRegEditId(null);
    setRegName("");
    setRegUrl("");
    setRegUsername("");
    setRegPassword("");
    setRegTrustedAuthRealm("");
    setRegScope("global");
    setRegNodeId("");
    setRegDialogOpen(true);
  };

  const openRegEdit = (r: DockerRegistry) => {
    if (!canEditRegistry || r.readOnly || r.integration) return;
    setRegEditId(r.id);
    setRegName(r.name);
    setRegUrl(r.url);
    setRegUsername(r.username ?? "");
    setRegPassword("");
    setRegTrustedAuthRealm(r.trustedAuthRealm ?? "");
    setRegScope(r.scope);
    setRegNodeId(r.nodeId ?? "");
    setRegDialogOpen(true);
  };

  const closeRegDialog = () => {
    setRegDialogOpen(false);
  };

  const handleRegSave = async () => {
    if (!regName.trim() || !regUrl.trim()) return;
    setRegSaving(true);
    try {
      const payload = {
        name: regName.trim(),
        url: regUrl.trim(),
        username: regUsername.trim() || undefined,
        password: regPassword || undefined,
        trustedAuthRealm: regTrustedAuthRealm.trim(),
        scope: regScope,
        nodeId: regScope === "node" ? regNodeId || undefined : undefined,
      };
      if (regEditId) {
        if (!canEditRegistry) return;
        await api.updateRegistry(regEditId, payload);
        toast.success("Registry updated");
      } else {
        if (!canCreateRegistry) return;
        if (canEditRegistry) {
          const testResult = await api.testRegistryDirect({
            url: regUrl.trim(),
            username: regUsername.trim() || undefined,
            password: regPassword || undefined,
            trustedAuthRealm: regTrustedAuthRealm.trim() || undefined,
          });
          if (!testResult.ok) {
            toast.error(
              `Connection test failed: ${testResult.error || "could not connect to registry"}`
            );
            setRegSaving(false);
            return;
          }
        }
        await api.createRegistry(payload);
        toast.success("Registry added");
      }
      closeRegDialog();
      loadRegistries();
    } catch (err) {
      toastApiError(err, "Failed to save registry");
    } finally {
      setRegSaving(false);
    }
  };

  const handleRegDelete = async (r: DockerRegistry) => {
    if (r.readOnly || r.integration) return;
    const ok = await confirm({
      title: "Delete Registry",
      description: `Delete registry "${r.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setRegDeleting(r.id);
    try {
      await api.deleteRegistry(r.id);
      toast.success("Registry deleted");
      loadRegistries();
    } catch (err) {
      toastApiError(err, "Failed to delete registry");
    } finally {
      setRegDeleting(null);
    }
  };

  const handleRegTest = async (r: DockerRegistry) => {
    setRegTesting(r.id);
    try {
      const result = await api.testRegistry(r.id);
      if (result.ok) {
        toast.success(`Connection to "${r.name}" successful`);
      } else {
        toast.error(`Connection failed: ${result.error ?? "unknown error"}`);
      }
    } catch (err) {
      toastApiError(err, "Connection test failed");
    } finally {
      setRegTesting(null);
    }
  };

  const registryScopeLabel = (r: DockerRegistry) =>
    r.scope === "global"
      ? "Global"
      : nodesList.find((n) => n.id === r.nodeId)?.displayName ||
        nodesList.find((n) => n.id === r.nodeId)?.hostname ||
        "Node";

  const renderRegistryRow = (r: DockerRegistry) => {
    const isIntegration = Boolean(r.integration);
    const canOpen = canEditRegistry && !isIntegration && !r.readOnly;
    const canTestRegistry = canEditRegistry;
    const status = r.integration?.status;
    return (
      <div
        key={r.id}
        className={`flex flex-col gap-3 p-4 transition-colors sm:flex-row sm:items-center sm:justify-between sm:gap-4 ${
          canOpen ? "cursor-pointer hover:bg-accent/50" : ""
        }`}
        onClick={canOpen ? () => openRegEdit(r) : undefined}
      >
        <div className="flex min-w-0 items-center gap-3">
          {r.integration?.provider === "gitlab" ? (
            <Gitlab className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : r.scope === "global" ? (
            <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{r.name}</p>
              <Badge variant={r.scope === "global" ? "default" : "secondary"} size="inline">
                {registryScopeLabel(r)}
              </Badge>
              {r.integration && (
                <Badge variant="secondary" size="inline">
                  GitLab
                </Badge>
              )}
              {status === "inaccessible" && (
                <Badge variant="destructive" size="inline">
                  Inaccessible
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {r.url}
              {r.username && ` (${r.username})`}
            </p>
            {r.integration?.projectFullPath && (
              <p className="text-xs text-muted-foreground">
                {r.integration.projectFullPath}
                {r.integration.connectorName && ` · ${r.integration.connectorName}`}
              </p>
            )}
            {r.trustedAuthRealm && (
              <p className="text-xs text-muted-foreground">Token service: {r.trustedAuthRealm}</p>
            )}
          </div>
        </div>
        <div
          className="flex w-full shrink-0 items-center gap-2 sm:w-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {canTestRegistry && (
            <Button
              variant="outline"
              pending={regTesting === r.id}
              onClick={() => handleRegTest(r)}
            >
              <Play />
              Test
            </Button>
          )}
          {canDeleteRegistry && !isIntegration && !r.readOnly && (
            <Button
              variant="outline"
              size="icon"
              aria-label={`Delete ${r.name}`}
              pending={regDeleting === r.id}
              onClick={() => handleRegDelete(r)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    );
  };

  useContentLoading(!initialLoadComplete);
  if (!initialLoadComplete) return null;

  return (
    <>
      <PanelShell
        icon={<Container className="h-4 w-4" />}
        title="Docker Registries"
        description="Configure private container registries for pulling images"
        actions={
          canCreateRegistry ? (
            <Button onClick={openRegCreate}>
              <Plus className="h-4 w-4" />
              Add Registry
            </Button>
          ) : null
        }
      >
        <div>
          {registries.length > 0 ? (
            <div className="divide-y divide-border">
              {manualRegistries.map(renderRegistryRow)}
              {gitLabRegistries.length > 0 && (
                <div>
                  {/* Structural disclosure header for the GitLab group, not an action button. */}
                  <button
                    type="button"
                    className="flex w-full items-center justify-between bg-muted/30 px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted/45"
                    onClick={toggleGitLabRegistriesExpanded}
                    aria-expanded={effectiveGitLabRegistriesExpanded}
                  >
                    <span>Provided by GitLab integrations</span>
                    <ChevronDown
                      className={`h-4 w-4 transition-transform duration-200 ${
                        effectiveGitLabRegistriesExpanded ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  <div
                    aria-hidden={!effectiveGitLabRegistriesExpanded}
                    inert={effectiveGitLabRegistriesExpanded ? undefined : true}
                    className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                      effectiveGitLabRegistriesExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                    }`}
                  >
                    <div
                      className={`min-h-0 overflow-hidden ${
                        effectiveGitLabRegistriesExpanded
                          ? "divide-y divide-border border-t border-border"
                          : ""
                      }`}
                    >
                      {gitLabRegistries.map(renderRegistryRow)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              message="No registries configured."
              actionLabel={canCreateRegistry ? "Add one" : undefined}
              onAction={canCreateRegistry ? openRegCreate : undefined}
              embedded
            />
          )}
        </div>
      </PanelShell>

      {/* Registry Add/Edit Dialog */}
      <Dialog open={regDialogOpen} onOpenChange={closeRegDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{regEditId ? "Edit Registry" : "Add Registry"}</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {regEditId
              ? "Update the registry configuration."
              : "Add a private container registry for image pulls."}
          </DialogDescription>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Name <span className="text-destructive">*</span>
              </label>
              <Input
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                placeholder="My Registry"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                URL <span className="text-destructive">*</span>
              </label>
              <Input
                value={regUrl}
                onChange={(e) => setRegUrl(e.target.value)}
                placeholder="ghcr.io"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Username <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                value={regUsername}
                onChange={(e) => setRegUsername(e.target.value)}
                placeholder="username"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Password <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                type="password"
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                placeholder={regEditId ? "(unchanged)" : "password or token"}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Trusted Token Service{" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                value={regTrustedAuthRealm}
                onChange={(e) => setRegTrustedAuthRealm(e.target.value)}
                placeholder="https://auth.registry.example.com"
              />
              <p className="text-xs text-muted-foreground">
                HTTPS origin that may receive these credentials for Bearer token exchange.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Scope</label>
              <Select
                value={regScope === "node" && regNodeId ? `node:${regNodeId}` : "global"}
                onValueChange={(v) => {
                  if (v === "global") {
                    setRegScope("global");
                    setRegNodeId("");
                  } else if (v.startsWith("node:")) {
                    setRegScope("node");
                    setRegNodeId(v.slice(5));
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Global (all nodes)</SelectItem>
                  {nodesList
                    .filter((n) => n.type === "docker")
                    .map((n) => (
                      <SelectItem key={n.id} value={`node:${n.id}`}>
                        {n.displayName || n.hostname}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeRegDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleRegSave}
              disabled={
                !regName.trim() ||
                !regUrl.trim() ||
                (!regEditId && !canCreateRegistry) ||
                (!!regEditId && !canEditRegistry)
              }
              pending={regSaving}
            >
              {regEditId ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
