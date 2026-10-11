import {
  ArrowLeft,
  Check,
  GitBranch,
  Github,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { ChoiceCard } from "@/components/common/ChoiceCard";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EditableStringList } from "@/components/common/EditableStringList";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import { Switch } from "@/components/ui/switch";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { GitConnector, GitConnectorProvider, GitConnectorRequest } from "@/types/integrations";
import { GitHubDeviceFlow } from "./GitHubDeviceFlow";

const initialForm = (provider: GitConnectorProvider): GitConnectorRequest => ({
  name: provider === "github" ? "GitHub" : "Git",
  baseUrl: provider === "github" ? "https://github.com" : "",
  enabled: true,
  username: "",
  token: "",
  allowlistEntries: [],
});

const CAPABILITY_LABELS: Record<string, string> = {
  projectsView: "Projects",
  repoRead: "Repo read",
  repoWrite: "Repo write",
  ciView: "CI view",
  ciEdit: "CI edit",
  variablesView: "Variables view",
  variablesEdit: "Variables edit",
  webhooksManage: "Webhooks manage",
  registryView: "Packages",
};

export function GitIntegrationsSection() {
  return (
    <div className="space-y-6">
      <GitConnectorPanel
        provider="github"
        title="GitHub Integrations"
        description="Account-wide GitHub OAuth or token connectors for repositories, Actions, variables, webhooks, and packages."
        icon={Github}
      />
      <GitConnectorPanel
        provider="git"
        title="Git Integrations"
        description="Token-based connectors for one or more repositories on any HTTPS Git host."
        icon={GitBranch}
      />
    </div>
  );
}

function GitConnectorPanel({
  provider,
  title,
  description,
  icon: Icon,
}: {
  provider: GitConnectorProvider;
  title: string;
  description: string;
  icon: typeof Github;
}) {
  const hasScope = useAuthStore((state) => state.hasScope);
  const canManage = hasScope(`integrations:${provider}:manage`);
  const canView = canManage || hasScope(`integrations:${provider}:view`);
  const cacheKey = `settings:${provider}-connectors`;
  const [connectors, setConnectors] = useState<GitConnector[]>(
    () => api.getCached<GitConnector[]>(cacheKey) ?? []
  );
  const [initialLoadComplete, setInitialLoadComplete] = useState(
    () => !canView || api.getCached<GitConnector[]>(cacheKey) !== undefined
  );
  const [editingConnector, setEditingConnector] = useState<GitConnector | null>(null);
  const [methodOpen, setMethodOpen] = useState(false);
  const {
    open: formOpen,
    setValue: setFormDialog,
    close: closeFormDialog,
  } = useDeferredDialogState<true>();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testedTokenSignature, setTestedTokenSignature] = useState<string | null>(null);
  const [form, setForm] = useState(() => initialForm(provider));
  const [repositoryUrls, setRepositoryUrls] = useState<string[]>([""]);
  // null until the availability check answers; the method dialog waits for it.
  const [githubOAuthAvailable, setGithubOAuthAvailable] = useState<boolean | null>(null);
  const [authMode, setAuthMode] = useState<"oauth" | "token">("token");
  const [githubOAuthActive, setGitHubOAuthActive] = useState(false);
  const [oauthStep, setOAuthStep] = useState(false);
  const refresh = useCallback(async () => {
    if (!canView) return;
    try {
      const data = await api.listGitConnectors(provider);
      api.setCache(cacheKey, data);
      setConnectors(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to load ${title}`);
    } finally {
      setInitialLoadComplete(true);
    }
  }, [cacheKey, canView, provider, title]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("integration.connector.changed", () => {
    void refresh();
  });

  useEffect(() => {
    if (!canView || provider !== "github") return;
    void api
      .getGitHubOAuthAvailability()
      .then(({ available }) => setGithubOAuthAvailable(available))
      .catch(() => setGithubOAuthAvailable(false));
  }, [canView, provider]);

  const resetForm = () => {
    setForm(initialForm(provider));
    setRepositoryUrls([""]);
    setTestedTokenSignature(null);
    setSaving(false);
    setTesting(false);
    setGitHubOAuthActive(false);
    setOAuthStep(false);
  };

  const openCreateDialog = () => {
    resetForm();
    setEditingConnector(null);
    if (provider === "github") setMethodOpen(true);
    else {
      setAuthMode("token");
      setFormDialog(true);
    }
  };

  const chooseGitHubMethod = (mode: "oauth" | "token") => {
    setAuthMode(mode);
    setMethodOpen(false);
    setFormDialog(true);
  };

  const closeForm = () => {
    closeFormDialog(() => {
      setEditingConnector(null);
      resetForm();
    });
  };

  const backToMethods = () => {
    closeFormDialog(() => {
      setEditingConnector(null);
      resetForm();
      setMethodOpen(true);
    });
  };

  const openEditDialog = (connector: GitConnector) => {
    setEditingConnector(connector);
    setAuthMode(connector.authMode);
    setForm({
      name: connector.name,
      baseUrl: connector.baseUrl,
      enabled: connector.enabled,
      username: connector.username ?? "",
      token: "",
      allowlistEntries: [],
    });
    const urls = (connector.allowlistEntries ?? []).map((entry) => entry.fullPath);
    setRepositoryUrls(urls.length > 0 ? urls : [""]);
    setTestedTokenSignature(null);
    setOAuthStep(false);
    setFormDialog(true);
  };

  const saveConnector = async () => {
    const wasEditing = editingConnector !== null;
    setSaving(true);
    try {
      if (editingConnector) {
        const urls = repositoryUrls.map((url) => url.trim()).filter(Boolean);
        await api.updateGitConnector(provider, editingConnector.id, {
          name: form.name.trim(),
          baseUrl: form.baseUrl.trim(),
          enabled: form.enabled,
          ...(provider === "git"
            ? {
                username: form.username?.trim() || undefined,
                allowlistEntries: urls.map((url) => ({
                  entryType: "project" as const,
                  remoteId: url,
                  fullPath: url,
                  name: url,
                  webUrl: url,
                })),
              }
            : {}),
          ...(provider === "github" && authMode === "token" ? { authMode: "token" as const } : {}),
          ...(form.token.trim() ? { token: form.token.trim() } : {}),
        });
      } else if (provider === "github") {
        await api.createGitConnector("github", {
          name: form.name.trim(),
          baseUrl: form.baseUrl.trim(),
          enabled: form.enabled,
          token: form.token.trim(),
        });
      } else {
        const urls = repositoryUrls.map((url) => url.trim()).filter(Boolean);
        if (!form.username?.trim() || !urls.length) return;
        await api.createGitConnector("git", {
          ...form,
          name: form.name.trim(),
          baseUrl: form.baseUrl.trim(),
          username: form.username.trim(),
          token: form.token.trim(),
          allowlistEntries: urls.map((url) => ({
            entryType: "project",
            remoteId: url,
            fullPath: url,
            name: url,
            webUrl: url,
          })),
        });
      }
      toast.success(
        `${provider === "github" ? "GitHub" : "Git"} connector ${wasEditing ? "saved" : "created"}`
      );
      closeForm();
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to save ${title} connector`);
    } finally {
      setSaving(false);
    }
  };

  const tokenSignature = [
    form.baseUrl.trim(),
    repositoryUrls.map((url) => url.trim()).join("\n"),
    form.username?.trim() ?? "",
    form.token,
  ].join("\n");
  const tokenTested = testedTokenSignature === tokenSignature;

  const testGitHubConnection = async () => {
    if (!form.baseUrl.trim() || !form.token.trim()) return;
    setTesting(true);
    try {
      const result = await api.previewGitHubConnectorTest({
        baseUrl: form.baseUrl.trim(),
        token: form.token.trim(),
      });
      setTestedTokenSignature(tokenSignature);
      toast.success(`Connected to GitHub as ${result.username}`);
    } catch (error) {
      setTestedTokenSignature(null);
      toast.error(error instanceof Error ? error.message : "GitHub connection test failed");
    } finally {
      setTesting(false);
    }
  };

  const testGitConnection = async () => {
    const [repositoryUrl] = repositoryUrls.map((url) => url.trim()).filter(Boolean);
    if (!form.baseUrl.trim() || !repositoryUrl || !form.username?.trim() || !form.token.trim())
      return;
    setTesting(true);
    try {
      await api.previewGitConnectorTest({
        baseUrl: form.baseUrl.trim(),
        repositoryUrl,
        username: form.username.trim(),
        token: form.token.trim(),
      });
      setTestedTokenSignature(tokenSignature);
      toast.success("Git connection test passed");
    } catch (error) {
      setTestedTokenSignature(null);
      toast.error(error instanceof Error ? error.message : "Git connection test failed");
    } finally {
      setTesting(false);
    }
  };

  const genericGitReady =
    provider === "git" &&
    Boolean(
      form.name.trim() &&
        form.baseUrl.trim() &&
        repositoryUrls.some((url) => url.trim()) &&
        form.username?.trim() &&
        (editingConnector || form.token.trim())
    );
  const githubFormReady =
    provider === "github" &&
    Boolean(
      form.name.trim() &&
        (authMode === "oauth" ||
          (form.baseUrl.trim() && (editingConnector?.authMode === "token" || form.token.trim())))
    );
  const switchingToOAuth =
    provider === "github" && editingConnector?.authMode !== "oauth" && authMode === "oauth";

  const testConnector = async (connector: GitConnector) => {
    setTestingId(connector.id);
    try {
      await api.testGitConnector(provider, connector.id);
      toast.success(`${provider === "github" ? "GitHub" : "Git"} connector test passed`);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connector test failed");
    } finally {
      setTestingId(null);
    }
  };

  const syncConnector = async (connector: GitConnector) => {
    setSyncingId(connector.id);
    try {
      await api.syncGitConnector(provider, connector.id);
      toast.success(`${provider === "github" ? "GitHub" : "Git"} connector synchronized`);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connector sync failed");
    } finally {
      setSyncingId(null);
    }
  };

  const deleteConnector = async (connector: GitConnector) => {
    const ok = await confirm({
      title: `Delete ${provider === "github" ? "GitHub" : "Git"} Connector`,
      description: `Delete "${connector.name}" and its stored credential?`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setDeletingId(connector.id);
    try {
      await api.deleteGitConnector(provider, connector.id);
      toast.success(`${provider === "github" ? "GitHub" : "Git"} connector deleted`);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete connector");
    } finally {
      setDeletingId(null);
    }
  };

  useContentLoading(canView && !initialLoadComplete);

  if (!canView || !initialLoadComplete) return null;

  return (
    <>
      <PanelShell
        icon={<Icon className="h-4 w-4" />}
        title={title}
        description={description}
        actions={
          canManage ? (
            <Button onClick={openCreateDialog}>
              <Plus className="h-4 w-4" />
              Add connector
            </Button>
          ) : null
        }
      >
        {connectors.length ? (
          <div className="divide-y divide-border">
            {connectors.map((connector) => (
              <GitConnectorRow
                key={connector.id}
                connector={connector}
                icon={Icon}
                canManage={canManage}
                testing={testingId === connector.id}
                syncing={syncingId === connector.id}
                deleting={deletingId === connector.id}
                onOpen={canManage ? () => openEditDialog(connector) : undefined}
                onTest={() => void testConnector(connector)}
                onSync={() => void syncConnector(connector)}
                onDelete={() => void deleteConnector(connector)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            message={`No ${provider === "github" ? "GitHub" : "Git"} connectors configured.`}
            actionLabel={canManage ? "Add connector" : undefined}
            onAction={canManage ? openCreateDialog : undefined}
            embedded
          />
        )}
      </PanelShell>

      {provider === "github" ? (
        <Dialog open={methodOpen} onOpenChange={setMethodOpen}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Add GitHub Connector</DialogTitle>
              <DialogDescription>
                Choose how Gateway should authorize account-wide access to GitHub.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <ContentLoading loading={githubOAuthAvailable === null} />
              <ChoiceCard
                icon={ShieldCheck}
                title="OAuth"
                description="Authorize your GitHub account without copying a token into Gateway."
                trailing={
                  <Badge variant={githubOAuthAvailable ? "secondary" : "outline"}>
                    {githubOAuthAvailable ? "Recommended" : "Unavailable"}
                  </Badge>
                }
                disabled={!githubOAuthAvailable}
                onClick={() => chooseGitHubMethod("oauth")}
              />
              <ChoiceCard
                icon={KeyRound}
                title="Personal access token"
                description="Connect GitHub.com or a GitHub Enterprise instance with a PAT."
                onClick={() => chooseGitHubMethod("token")}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setMethodOpen(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      <Dialog open={formOpen} onOpenChange={(open) => (open ? setFormDialog(true) : closeForm())}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {oauthStep
                ? "Authorize GitHub"
                : editingConnector
                  ? `${provider === "github" ? "GitHub" : "Git"} Connector`
                  : provider === "github"
                    ? authMode === "oauth"
                      ? "Connect GitHub with OAuth"
                      : "Connect GitHub with a Token"
                    : "Add Git Connector"}
            </DialogTitle>
            <DialogDescription>
              {oauthStep
                ? "Authorize the selected GitHub account to update this connector without changing its project bindings."
                : provider === "github"
                  ? "The connector can use repositories visible to the authorized GitHub account."
                  : "Gateway encrypts the credential and uses it only for the configured repositories."}
            </DialogDescription>
          </DialogHeader>

          {provider === "github" && authMode === "oauth" && editingConnector && oauthStep ? (
            <GitHubDeviceFlow
              request={{
                connectorId: editingConnector.id,
                name: form.name.trim(),
                enabled: form.enabled,
              }}
              disabled={!form.name.trim()}
              onActiveChange={setGitHubOAuthActive}
              onCompleted={async () => {
                toast.success("GitHub connector reauthorized");
                closeForm();
                await refresh();
              }}
            />
          ) : provider === "github" && authMode === "oauth" && !editingConnector ? (
            <div className={githubOAuthActive ? "" : "border border-border"}>
              {!githubOAuthActive ? (
                <SettingsControlRow
                  title="Connector name"
                  description="A label for this source-control connection in Gateway."
                >
                  <Input
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    placeholder="Connector name"
                    autoFocus
                  />
                </SettingsControlRow>
              ) : null}
              <div
                className={cn(
                  githubOAuthActive
                    ? ""
                    : "grid gap-3 border-t border-border px-4 py-3 sm:grid-cols-[minmax(12rem,1fr)_auto] sm:items-center"
                )}
              >
                {!githubOAuthActive ? (
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Authorization</div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Start authorization, then open GitHub after the code appears.
                    </p>
                  </div>
                ) : null}
                <div
                  className={cn(
                    githubOAuthActive
                      ? "w-full"
                      : "flex w-full shrink-0 items-center justify-end sm:w-auto sm:min-w-[14rem] sm:max-w-[24rem]"
                  )}
                >
                  <GitHubDeviceFlow
                    request={{ name: form.name.trim(), enabled: form.enabled }}
                    disabled={!form.name.trim()}
                    onActiveChange={setGitHubOAuthActive}
                    onCompleted={async () => {
                      toast.success("GitHub connector created");
                      closeForm();
                      await refresh();
                    }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <AnimatedHeight>
              <PanelShell
                icon={<KeyRound className="h-4 w-4" />}
                title={
                  provider === "github"
                    ? authMode === "oauth"
                      ? "GitHub OAuth"
                      : "GitHub personal access token"
                    : "Git repository access"
                }
                description={
                  provider === "github"
                    ? authMode === "oauth"
                      ? "Authorize GitHub.com through Device Flow."
                      : "Test the token before saving the encrypted connector."
                    : "Connect one or more repositories on a generic Git host."
                }
              >
                <SettingsControlRow title="Connector name">
                  <Input
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    placeholder="Connector name"
                    autoFocus
                  />
                </SettingsControlRow>

                {editingConnector ? (
                  <SettingsControlRow
                    title="Enabled"
                    description="Allow Gateway to use this connector."
                  >
                    <Switch
                      checked={form.enabled}
                      onChange={(enabled) => setForm({ ...form, enabled })}
                      ariaLabel="Connector enabled"
                    />
                  </SettingsControlRow>
                ) : null}

                {provider === "github" && editingConnector ? (
                  <SettingsControlRow
                    title="Authentication"
                    description="Change the credential without recreating the connector or its project bindings."
                  >
                    <Select
                      value={authMode}
                      onValueChange={(value) => {
                        setAuthMode(value as "oauth" | "token");
                        setOAuthStep(false);
                        setTestedTokenSignature(null);
                        setForm((current) => ({ ...current, token: "" }));
                      }}
                    >
                      <SelectTrigger aria-label="GitHub authentication method" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="oauth" disabled={!githubOAuthAvailable}>
                          OAuth
                        </SelectItem>
                        <SelectItem value="token">Personal access token</SelectItem>
                      </SelectContent>
                    </Select>
                  </SettingsControlRow>
                ) : null}

                {provider === "github" && authMode === "token" ? (
                  <>
                    <SettingsControlRow
                      title="GitHub URL"
                      description="Use github.com or the base URL of a GitHub Enterprise instance."
                    >
                      <Input
                        value={form.baseUrl}
                        onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                        placeholder="https://github.com"
                      />
                    </SettingsControlRow>
                    <SettingsControlRow
                      title="Personal access token"
                      description="Gateway validates the token without storing it until you save."
                      controlsClassName="sm:min-w-[22rem] sm:max-w-none"
                    >
                      <div className="flex w-full min-w-0 border border-input bg-background">
                        <Input
                          type="password"
                          value={form.token}
                          onChange={(event) => setForm({ ...form, token: event.target.value })}
                          placeholder={
                            editingConnector?.tokenMasked ?? "GitHub personal access token"
                          }
                          className="h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent focus-visible:ring-0"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          className="shrink-0 rounded-none border-l border-border bg-muted px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
                          disabled={!form.baseUrl.trim() || !form.token.trim()}
                          pending={testing}
                          onClick={() => void testGitHubConnection()}
                        >
                          {!testing && tokenTested ? <Check className="h-4 w-4" /> : null}
                          Test Connection
                        </Button>
                      </div>
                    </SettingsControlRow>
                  </>
                ) : null}

                {provider === "git" ? (
                  <>
                    <SettingsControlRow title="Git host URL">
                      <Input
                        value={form.baseUrl}
                        onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                        placeholder="https://git.example.com"
                      />
                    </SettingsControlRow>
                    <SettingsControlRow
                      title="Repositories"
                      description="Add every repository this credential should make available to Gateway."
                    >
                      <EditableStringList
                        values={repositoryUrls}
                        onChange={setRepositoryUrls}
                        placeholder="https://git.example.com/team/repository"
                        itemLabel="Repository URL"
                      />
                    </SettingsControlRow>
                    <SettingsControlRow title="Username">
                      <Input
                        value={form.username ?? ""}
                        onChange={(event) => setForm({ ...form, username: event.target.value })}
                        placeholder="Git username"
                      />
                    </SettingsControlRow>
                    <SettingsControlRow
                      title="Access token"
                      description="Test the credential against the first configured repository before saving."
                      controlsClassName="sm:min-w-[22rem] sm:max-w-none"
                    >
                      <div className="flex w-full min-w-0 border border-input bg-background">
                        <Input
                          type="password"
                          value={form.token}
                          onChange={(event) => setForm({ ...form, token: event.target.value })}
                          placeholder={editingConnector?.tokenMasked ?? "Access token"}
                          className="h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent focus-visible:ring-0"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          className="shrink-0 rounded-none border-l border-border bg-muted px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
                          disabled={
                            !form.baseUrl.trim() ||
                            !repositoryUrls.some((url) => url.trim()) ||
                            !form.username?.trim() ||
                            !form.token.trim()
                          }
                          pending={testing}
                          onClick={() => void testGitConnection()}
                        >
                          {!testing && tokenTested ? <Check className="h-4 w-4" /> : null}
                          Test Connection
                        </Button>
                      </div>
                    </SettingsControlRow>
                  </>
                ) : null}
              </PanelShell>
            </AnimatedHeight>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => closeForm()}>
              Cancel
            </Button>
            {oauthStep ? (
              <Button variant="outline" onClick={() => setOAuthStep(false)}>
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
            ) : null}
            {provider === "github" && !editingConnector ? (
              <Button variant="outline" onClick={backToMethods}>
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
            ) : null}
            {editingConnector && provider === "github" && authMode === "oauth" && !oauthStep ? (
              <Button disabled={!form.name.trim()} onClick={() => setOAuthStep(true)}>
                {switchingToOAuth ? "Continue" : "Reauthorize"}
              </Button>
            ) : null}
            {(editingConnector || provider === "git" || authMode === "token") &&
            !oauthStep &&
            !switchingToOAuth ? (
              <Button
                disabled={!(genericGitReady || githubFormReady)}
                pending={saving}
                onClick={() => void saveConnector()}
              >
                {saving ? "Saving…" : editingConnector ? "Save" : "Save connector"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function GitConnectorRow({
  connector,
  icon: Icon,
  canManage,
  testing,
  syncing,
  deleting,
  onOpen,
  onTest,
  onSync,
  onDelete,
}: {
  connector: GitConnector;
  icon: typeof Github;
  canManage: boolean;
  testing: boolean;
  syncing: boolean;
  deleting: boolean;
  onOpen?: () => void;
  onTest: () => void;
  onSync: () => void;
  onDelete: () => void;
}) {
  const selectedRepositoryCount = connector.allowlistEntries?.length ?? 0;
  const accessLabel =
    connector.provider === "github"
      ? "All visible"
      : `${selectedRepositoryCount} ${selectedRepositoryCount === 1 ? "repository" : "repositories"}`;
  const testedLabel = connector.testedAt ? (
    <>
      Tested <RelativeTime value={connector.testedAt} />
    </>
  ) : (
    "Never tested"
  );
  const status =
    connector.syncStatus === "error"
      ? "error"
      : connector.testedAt
        ? "success"
        : connector.syncStatus;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 p-4 transition-colors lg:flex-row lg:items-center lg:justify-between",
        onOpen && "cursor-pointer hover:bg-accent/50"
      )}
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-muted">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{connector.name}</p>
            <Badge variant={connector.enabled ? "secondary" : "outline"} size="inline">
              {connector.enabled ? "enabled" : "disabled"}
            </Badge>
            <Badge variant={status === "error" ? "destructive" : "outline"} size="inline">
              {status}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {connector.baseUrl} &middot; {accessLabel}
            {connector.username ? ` · ${connector.username}` : ""}
            {connector.authMode === "oauth"
              ? " · OAuth"
              : connector.tokenMasked
                ? ` · Token ${connector.tokenMasked}`
                : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {connector.syncFinishedAt && (
              <>
                Synced <RelativeTime value={connector.syncFinishedAt} />
                {" · "}
              </>
            )}
            {testedLabel}
            {connector.syncLastError ? ` · ${connector.syncLastError}` : ""}
          </p>
          <CapabilityBadges capabilities={connector.capabilities} className="mt-2" />
        </div>
      </div>
      {canManage ? (
        <div className="flex shrink-0 items-center gap-2 lg:self-center">
          <Button
            variant="outline"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              onTest();
            }}
            disabled={syncing}
            pending={testing}
            title="Test connector"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              onSync();
            }}
            disabled={testing}
            pending={syncing}
            title="Sync connector"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            pending={deleting}
            title="Delete connector"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CapabilityBadges({
  capabilities,
  className,
}: {
  capabilities: Record<string, boolean>;
  className?: string;
}) {
  const enabled = Object.entries(capabilities)
    .filter(([, value]) => value)
    .map(([key]) => CAPABILITY_LABELS[key] ?? key);

  if (enabled.length === 0) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>No capabilities detected</p>
    );
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {enabled.map((label) => (
        <Badge key={label} variant="outline" size="inline">
          {label}
        </Badge>
      ))}
    </div>
  );
}
