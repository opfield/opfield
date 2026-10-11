import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  GitFork,
  Gitlab,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { type ScopeItem, ScopeList } from "@/components/common/ScopeList";
import {
  ScopeSearchFilter,
  type ScopeSelectionFilter,
} from "@/components/common/ScopeSearchFilter";
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
import { useRealtime } from "@/hooks/use-realtime";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  GitLabAllowlistEntry,
  GitLabAllowlistMode,
  GitLabConnector,
  GitLabConnectorSettings,
} from "@/types/integrations";
import { CloudflareIntegrationsSection } from "./CloudflareIntegrationsSection";
import { ExternalSshIntegrationsSection } from "./ExternalSshIntegrationsSection";
import { GitIntegrationsSection } from "./GitIntegrationsSection";
import { HostingIntegrationsSection } from "./HostingIntegrationsSection";

const DEFAULT_SETTINGS: GitLabConnectorSettings = {
  autoSyncEnabled: true,
  autoSyncIntervalSeconds: 900,
  cloneShallow: true,
  cloneDepth: 1,
  cloneLfs: false,
  cloneSubmodules: false,
  cloneMaxSizeMb: 1024,
  cloneTimeoutSeconds: 300,
};

const CAPABILITY_LABELS: Record<string, string> = {
  api: "API",
  projects: "Projects",
  repositoryRead: "Repo read",
  repositoryWrite: "Repo write",
  ciLint: "CI lint",
  ciRead: "CI read",
  ciWrite: "CI edit",
  variablesRead: "Variables read",
  variablesWrite: "Variables edit",
  webhooksRead: "Webhooks read",
  webhooksWrite: "Webhooks edit",
  registryRead: "Registry read",
  registryWrite: "Registry edit",
  deployTokens: "Deploy tokens",
};

const CONNECTOR_STEP_LABELS = ["Connection", "Access", "Sync & clone", "Review"];
const CONNECTOR_STEP_COUNT = CONNECTOR_STEP_LABELS.length;
const CONNECTOR_STEP_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

function allowlistEntryKey(entry: GitLabAllowlistEntry) {
  return `${entry.entryType}:${entry.remoteId}`;
}

function mergeAllowlistEntries(
  ...entryLists: Array<readonly GitLabAllowlistEntry[] | null | undefined>
) {
  const keyed = new Map<string, GitLabAllowlistEntry>();
  for (const entries of entryLists) {
    for (const entry of entries ?? []) {
      keyed.set(allowlistEntryKey(entry), entry);
    }
  }
  return [...keyed.values()];
}

function ConnectorStepHeight({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");

  useLayoutEffect(() => {
    if (containerRef.current) {
      setHeight(containerRef.current.getBoundingClientRect().height);
    }
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setHeight(entry.contentRect.height);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      animate={{ height }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      className="overflow-hidden"
    >
      <div ref={containerRef}>{children}</div>
    </motion.div>
  );
}

function mergeSettings(settings?: Partial<GitLabConnectorSettings>): GitLabConnectorSettings {
  return { ...DEFAULT_SETTINGS, ...settings };
}

function emptyForm() {
  return {
    name: "",
    baseUrl: "https://gitlab.com",
    token: "",
    enabled: true,
    allowlistMode: "selected" as GitLabAllowlistMode,
    settings: DEFAULT_SETTINGS,
    allowlistEntries: [] as GitLabAllowlistEntry[],
  };
}

export function IntegrationsSection() {
  return (
    <div className="space-y-6">
      <CloudflareIntegrationsSection />
      <GitLabIntegrationsSection />
      <GitIntegrationsSection />
      <ExternalSshIntegrationsSection />
      <HostingIntegrationsSection />
    </div>
  );
}

function GitLabIntegrationsSection() {
  const { hasScope } = useAuthStore();
  if (!hasScope("integrations:gitlab:manage") && !hasScope("integrations:gitlab:view")) return null;
  return (
    <LicenseFeatureBoundary feature="gitlab" capability="GitLab integration">
      <GitLabIntegrationsContent />
    </LicenseFeatureBoundary>
  );
}

function GitLabIntegrationsContent() {
  const { hasScope } = useAuthStore();
  const canManage = hasScope("integrations:gitlab:manage");
  const canView = canManage || hasScope("integrations:gitlab:view");
  const [connectors, setConnectors] = useState<GitLabConnector[]>(
    () => api.getCached<GitLabConnector[]>("settings:gitlab-connectors") ?? []
  );
  const [initialLoadComplete, setInitialLoadComplete] = useState(
    () => !canView || api.getCached<GitLabConnector[]>("settings:gitlab-connectors") !== undefined
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConnector, setEditingConnector] = useState<GitLabConnector | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [refreshingAllowlist, setRefreshingAllowlist] = useState(false);
  const [search, setSearch] = useState("");
  const [allowlistFilter, setAllowlistFilter] = useState<ScopeSelectionFilter>("all");
  const [searchResults, setSearchResults] = useState<GitLabAllowlistEntry[]>([]);
  const [availableAllowlistEntries, setAvailableAllowlistEntries] = useState<
    GitLabAllowlistEntry[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [dialogStep, setDialogStep] = useState(1);
  const firstDialogStep = editingConnector ? 2 : 1;
  const lastDialogStep = editingConnector ? 3 : CONNECTOR_STEP_COUNT;
  const visibleDialogStep = editingConnector ? dialogStep - 1 : dialogStep;
  const visibleDialogStepCount = editingConnector ? 2 : CONNECTOR_STEP_COUNT;
  const dialogStepLabel = CONNECTOR_STEP_LABELS[dialogStep - 1];

  const canSearchAllowlist =
    form.allowlistMode === "selected" &&
    (Boolean(editingConnector?.id) || Boolean(form.baseUrl.trim() && form.token.trim()));
  const selectedEntryValues = useMemo(
    () =>
      (form.allowlistMode === "all_visible"
        ? availableAllowlistEntries
        : form.allowlistEntries
      ).map(allowlistEntryKey),
    [availableAllowlistEntries, form.allowlistEntries, form.allowlistMode]
  );
  const displayedAllowlistEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return availableAllowlistEntries;
    if (!editingConnector) return searchResults;
    return availableAllowlistEntries.filter(
      (entry) =>
        entry.fullPath.toLowerCase().includes(query) ||
        (entry.name ?? "").toLowerCase().includes(query)
    );
  }, [availableAllowlistEntries, editingConnector, search, searchResults]);
  const displayedAllowlistItems = useMemo<ScopeItem[]>(
    () =>
      displayedAllowlistEntries.map((entry) => ({
        value: allowlistEntryKey(entry),
        label: entry.fullPath,
        desc: entry.entryType === "group" ? "GitLab group" : "GitLab project",
        group: entry.entryType === "group" ? "Groups" : "Projects",
      })),
    [displayedAllowlistEntries]
  );

  const loadConnectors = useCallback(async () => {
    if (!canView) return;
    try {
      const data = await api.listGitLabConnectors();
      api.setCache("settings:gitlab-connectors", data ?? []);
      setConnectors(data ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load integrations");
    } finally {
      setInitialLoadComplete(true);
    }
  }, [canView]);

  useEffect(() => {
    loadConnectors();
  }, [loadConnectors]);

  useRealtime("integration.connector.changed", () => {
    loadConnectors();
  });

  useEffect(() => {
    if (editingConnector || dialogStep !== 2 || !canSearchAllowlist || search.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await api.previewGitLabAllowlistSearch({
          baseUrl: form.baseUrl.trim(),
          token: form.token.trim(),
          q: search.trim(),
        });
        if (!cancelled) setSearchResults(results);
      } catch (error) {
        if (!cancelled) {
          setSearchResults([]);
          toast.error(error instanceof Error ? error.message : "GitLab search failed");
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canSearchAllowlist, dialogStep, editingConnector, form.baseUrl, form.token, search]);

  const openCreateDialog = () => {
    if (!requireLicenseFeature("gitlab", "GitLab integration")) return;
    setEditingConnector(null);
    setForm(emptyForm());
    setRefreshingAllowlist(false);
    setSearch("");
    setAllowlistFilter("all");
    setSearchResults([]);
    setAvailableAllowlistEntries([]);
    setDialogStep(1);
    setDialogOpen(true);
  };

  const openEditDialog = async (connector: GitLabConnector) => {
    if (!requireLicenseFeature("gitlab", "GitLab integration")) return;
    setDialogOpen(true);
    setEditingConnector(connector);
    setLoadingDetail(true);
    setSearch("");
    setAllowlistFilter("all");
    setSearchResults([]);
    setAvailableAllowlistEntries(connector.allowlistEntries ?? []);
    setDialogStep(2);

    try {
      const detail = await api.getGitLabConnector(connector.id);
      let allowlistOptions = detail.allowlistEntries ?? [];
      try {
        allowlistOptions = mergeAllowlistEntries(
          await api.listGitLabAllowlistOptions(connector.id),
          detail.allowlistEntries
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load GitLab projects");
      }
      setEditingConnector(detail);
      setForm({
        name: detail.name,
        baseUrl: detail.baseUrl,
        token: "",
        enabled: detail.enabled,
        allowlistMode: detail.allowlistMode,
        settings: mergeSettings(detail.settings),
        allowlistEntries: detail.allowlistEntries ?? [],
      });
      setAvailableAllowlistEntries(allowlistOptions);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load connector");
      setDialogOpen(false);
    } finally {
      setLoadingDetail(false);
    }
  };

  const closeDialog = () => {
    setDialogOpen(false);
  };

  const refreshAllowlistOptions = async () => {
    if (!editingConnector) return;
    setRefreshingAllowlist(true);
    try {
      const options = await api.refreshGitLabAllowlistOptions(editingConnector.id);
      const merged = mergeAllowlistEntries(options, form.allowlistEntries);
      setAvailableAllowlistEntries(merged);
      if (form.allowlistMode === "all_visible") {
        setForm((current) => ({ ...current, allowlistEntries: merged }));
      }
      setSearch("");
      setAllowlistFilter("all");
      setSearchResults([]);
      toast.success("GitLab projects updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update GitLab projects");
    } finally {
      setRefreshingAllowlist(false);
    }
  };

  const updateSettings = (patch: Partial<GitLabConnectorSettings>) => {
    setForm((current) => ({
      ...current,
      settings: mergeSettings({ ...current.settings, ...patch }),
    }));
  };

  const toggleAllowlistEntry = (entry: GitLabAllowlistEntry) => {
    const key = allowlistEntryKey(entry);
    setForm((current) => {
      const exists = current.allowlistEntries.some((item) => allowlistEntryKey(item) === key);
      return {
        ...current,
        allowlistEntries: exists
          ? current.allowlistEntries.filter((item) => allowlistEntryKey(item) !== key)
          : [...current.allowlistEntries, entry],
      };
    });
  };

  const toggleAllowlistEntryByKey = (key: string) => {
    const entry = displayedAllowlistEntries.find((item) => allowlistEntryKey(item) === key);
    if (entry) toggleAllowlistEntry(entry);
  };

  const updateAllowlistMode = (mode: GitLabAllowlistMode) => {
    if (mode === "all_visible") {
      setSearch("");
      setAllowlistFilter("all");
      setSearchResults([]);
    }
    setForm((current) => ({
      ...current,
      allowlistMode: mode,
      allowlistEntries:
        mode === "all_visible" ? availableAllowlistEntries : current.allowlistEntries,
    }));
  };

  const validateForm = () => {
    if (!form.name.trim()) {
      toast.error("Connector name is required");
      return false;
    }
    if (!form.baseUrl.trim()) {
      toast.error("GitLab URL is required");
      return false;
    }
    if (!editingConnector && !form.token.trim()) {
      toast.error("GitLab token is required");
      return false;
    }
    return true;
  };

  const canContinueFromConnection = () =>
    Boolean(form.name.trim()) &&
    Boolean(form.baseUrl.trim()) &&
    (Boolean(editingConnector) || Boolean(form.token.trim()));

  const canContinueFromAccessSelection = () =>
    form.allowlistMode === "all_visible"
      ? availableAllowlistEntries.length > 0
      : form.allowlistEntries.length > 0;

  const testConnectionForDialog = async ({ advance }: { advance: boolean }) => {
    if (!validateForm()) return false;
    setTestingConnection(true);
    try {
      const result =
        editingConnector && !form.token.trim()
          ? await api.testGitLabConnector(editingConnector.id).then((connector) => ({
              capabilities: connector.capabilities,
              allowlistEntries: connector.allowlistEntries ?? [],
            }))
          : await api.previewGitLabConnectorTest({
              baseUrl: form.baseUrl.trim(),
              token: form.token.trim(),
            });
      setAvailableAllowlistEntries(result.allowlistEntries);
      if (form.allowlistMode === "all_visible") {
        setForm((current) => ({ ...current, allowlistEntries: result.allowlistEntries }));
      }
      setSearch("");
      setAllowlistFilter("all");
      setSearchResults([]);
      toast.success("GitLab connection test passed");
      if (advance) setDialogStep(2);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "GitLab connection test failed");
      return false;
    } finally {
      setTestingConnection(false);
    }
  };

  const canContinueFromAccess = () => {
    if (!availableAllowlistEntries.some((entry) => entry.entryType === "project")) {
      toast.error("No available GitLab projects found");
      return false;
    }
    return true;
  };

  const goNext = async () => {
    if (dialogStep === 1 && !canContinueFromConnection()) {
      validateForm();
      return;
    }
    if (dialogStep === 1) {
      await testConnectionForDialog({ advance: true });
      return;
    }
    if (dialogStep === 2 && !canContinueFromAccess()) return;
    setDialogStep((step) => Math.min(lastDialogStep, step + 1));
  };

  const goBack = () => {
    setDialogStep((step) => Math.max(firstDialogStep, step - 1));
  };

  const saveConnector = async () => {
    if (!validateForm()) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        enabled: form.enabled,
        ...(form.token.trim() ? { token: form.token.trim() } : {}),
        allowlistMode: form.allowlistMode,
        settings: form.settings,
        allowlistEntries:
          form.allowlistMode === "selected"
            ? form.allowlistEntries
            : ([] as GitLabAllowlistEntry[]),
      };

      if (editingConnector) {
        const updated = await api.updateGitLabConnector(editingConnector.id, payload);
        setEditingConnector(updated);
        toast.success("GitLab connector saved");
      } else {
        await api.createGitLabConnector({ ...payload, token: form.token.trim() });
        toast.success("GitLab connector created");
      }

      closeDialog();
      loadConnectors();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save connector");
    } finally {
      setSaving(false);
    }
  };

  const testConnector = async (connector: GitLabConnector) => {
    setTestingId(connector.id);
    try {
      await api.testGitLabConnector(connector.id);
      toast.success("GitLab connector test passed");
      loadConnectors();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "GitLab connector test failed");
    } finally {
      setTestingId(null);
    }
  };

  const syncConnector = async (connector: GitLabConnector) => {
    setSyncingId(connector.id);
    try {
      await api.syncGitLabConnector(connector.id);
      toast.success("GitLab connector synced");
      loadConnectors();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "GitLab sync failed");
    } finally {
      setSyncingId(null);
    }
  };

  const deleteConnector = async (connector: GitLabConnector) => {
    const ok = await confirm({
      title: "Delete GitLab Connector",
      description: `Delete "${connector.name}" and its synced GitLab integration data?`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setDeletingId(connector.id);
    try {
      await api.deleteGitLabConnector(connector.id);
      toast.success("GitLab connector deleted");
      loadConnectors();
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
        icon={<Gitlab className="h-4 w-4" />}
        title="GitLab Integrations"
        description="System connectors for GitLab repositories, CI, and registries."
        actions={
          canManage ? (
            <Button onClick={openCreateDialog}>
              <Plus className="h-4 w-4" />
              Add connector
            </Button>
          ) : null
        }
      >
        {connectors.length > 0 ? (
          <div className="divide-y divide-border">
            {connectors.map((connector) => (
              <ConnectorRow
                key={connector.id}
                connector={connector}
                canManage={canManage}
                testing={testingId === connector.id}
                syncing={syncingId === connector.id || connector.syncStatus === "running"}
                deleting={deletingId === connector.id}
                onOpen={canManage ? () => openEditDialog(connector) : undefined}
                onTest={() => testConnector(connector)}
                onSync={() => syncConnector(connector)}
                onDelete={() => deleteConnector(connector)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            message="No GitLab connectors configured."
            actionLabel={canManage ? "Add connector" : undefined}
            onAction={canManage ? openCreateDialog : undefined}
            embedded
          />
        )}
      </PanelShell>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {editingConnector ? "GitLab Connector" : "Add GitLab Connector"}
            </DialogTitle>
            <DialogDescription>
              Step {visibleDialogStep} of {visibleDialogStepCount} — {dialogStepLabel}
            </DialogDescription>
          </DialogHeader>

          {loadingDetail ? (
            // Reports the connector detail load to the dialog, which opens once it is ready.
            // One body child either way, so the dialog body keeps its layout.
            <ContentLoading loading />
          ) : (
            <div>
              <ConnectorStepHeight>
                <AnimatePresence mode="wait" initial={false}>
                  {dialogStep === 1 && (
                    <motion.div
                      key="gitlab-connector-step-1"
                      {...CONNECTOR_STEP_ANIMATION}
                      className="space-y-4"
                    >
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Name">
                          <Input
                            value={form.name}
                            disabled={!canManage}
                            onChange={(event) =>
                              setForm((current) => ({ ...current, name: event.target.value }))
                            }
                            placeholder="Production GitLab"
                          />
                        </Field>
                        <Field label="Base URL">
                          <Input
                            value={form.baseUrl}
                            disabled={!canManage}
                            onChange={(event) =>
                              setForm((current) => ({ ...current, baseUrl: event.target.value }))
                            }
                            placeholder="https://gitlab.com"
                          />
                        </Field>
                      </div>

                      <Field label={editingConnector ? "Token" : "Personal Access Token"}>
                        <div className="flex min-w-0 border border-input bg-background">
                          <Input
                            value={form.token}
                            disabled={!canManage}
                            onChange={(event) =>
                              setForm((current) => ({ ...current, token: event.target.value }))
                            }
                            placeholder={editingConnector?.tokenMasked ?? "glpat-..."}
                            type="password"
                            className="h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent focus-visible:ring-0"
                          />
                          <Button
                            variant="ghost"
                            className="shrink-0 rounded-none border-l border-border bg-muted px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
                            onClick={() => void testConnectionForDialog({ advance: false })}
                            disabled={!canContinueFromConnection()}
                            pending={testingConnection}
                          >
                            Test Connection
                          </Button>
                        </div>
                      </Field>
                    </motion.div>
                  )}

                  {dialogStep === 2 && (
                    <motion.div
                      key="gitlab-connector-step-2"
                      {...CONNECTOR_STEP_ANIMATION}
                      className="space-y-4"
                    >
                      {editingConnector && (
                        <Field label="Token">
                          <p className="mb-2 text-xs text-muted-foreground">
                            Leave empty to keep the current token.
                          </p>
                          <div className="flex min-w-0 border border-input bg-background">
                            <Input
                              value={form.token}
                              disabled={!canManage}
                              onChange={(event) =>
                                setForm((current) => ({ ...current, token: event.target.value }))
                              }
                              placeholder={editingConnector.tokenMasked ?? "glpat-..."}
                              type="password"
                              className="h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent focus-visible:ring-0"
                            />
                            <Button
                              variant="ghost"
                              className="shrink-0 rounded-none border-l border-border bg-muted px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
                              onClick={() => void testConnectionForDialog({ advance: false })}
                              pending={testingConnection}
                            >
                              Test Connection
                            </Button>
                          </div>
                        </Field>
                      )}

                      <Field label="Project Access">
                        <div className="flex gap-2">
                          <Select
                            value={form.allowlistMode}
                            disabled={!canManage}
                            onValueChange={(value) =>
                              updateAllowlistMode(value as GitLabAllowlistMode)
                            }
                          >
                            <SelectTrigger className="min-w-0 flex-1">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="selected">Selected projects and groups</SelectItem>
                              <SelectItem value="all_visible">All visible projects</SelectItem>
                            </SelectContent>
                          </Select>
                          {editingConnector && (
                            <Button
                              type="button"
                              variant="outline"
                              disabled={!canManage}
                              pending={refreshingAllowlist}
                              onClick={() => void refreshAllowlistOptions()}
                            >
                              <RefreshCw className="h-4 w-4" />
                              Update
                            </Button>
                          )}
                        </div>
                      </Field>

                      <div className="border border-border">
                        <div>
                          <ScopeSearchFilter
                            search={search}
                            onSearchChange={setSearch}
                            filter={allowlistFilter}
                            onFilterChange={setAllowlistFilter}
                            placeholder="Search GitLab projects and groups..."
                            disabled={
                              !canManage ||
                              refreshingAllowlist ||
                              form.allowlistMode === "all_visible" ||
                              !canSearchAllowlist
                            }
                          />
                        </div>
                        <div className="max-h-[min(18rem,36dvh)] overflow-y-auto overscroll-contain">
                          {searching ? (
                            <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Searching GitLab
                            </div>
                          ) : refreshingAllowlist ? (
                            <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Updating projects
                            </div>
                          ) : (
                            <ScopeList
                              scopes={displayedAllowlistItems}
                              search={search}
                              selectionFilter={allowlistFilter}
                              selected={selectedEntryValues}
                              onToggle={toggleAllowlistEntryByKey}
                              readOnly={form.allowlistMode === "all_visible"}
                              viewportClassName="max-h-none max-sm:max-h-none"
                            />
                          )}
                        </div>
                        <div className="border-t border-border px-3 py-2">
                          <p className="text-xs text-muted-foreground">
                            {form.allowlistMode === "all_visible"
                              ? `${availableAllowlistEntries.length} available`
                              : `${form.allowlistEntries.length} selected`}
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {dialogStep === 3 && (
                    <motion.div
                      key="gitlab-connector-step-3"
                      {...CONNECTOR_STEP_ANIMATION}
                      className="space-y-4"
                    >
                      <PanelShell
                        title="Sync & Clone"
                        description="Project discovery schedule and sandbox clone limits."
                        icon={<GitFork className="h-4 w-4" />}
                      >
                        <SettingsControlRow
                          title="Auto Sync"
                          description="Refresh visible projects and registry metadata."
                        >
                          <Select
                            value={
                              form.settings.autoSyncEnabled
                                ? String(form.settings.autoSyncIntervalSeconds)
                                : "disabled"
                            }
                            disabled={!canManage}
                            onValueChange={(value) =>
                              updateSettings(
                                value === "disabled"
                                  ? { autoSyncEnabled: false }
                                  : {
                                      autoSyncEnabled: true,
                                      autoSyncIntervalSeconds: Number(value),
                                    }
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="disabled">Disabled</SelectItem>
                              <SelectItem value="300">Every 5 minutes</SelectItem>
                              <SelectItem value="900">Every 15 minutes</SelectItem>
                              <SelectItem value="3600">Every hour</SelectItem>
                              <SelectItem value="21600">Every 6 hours</SelectItem>
                              <SelectItem value="86400">Daily</SelectItem>
                            </SelectContent>
                          </Select>
                        </SettingsControlRow>
                        <SettingsControlRow
                          title="Clone Depth"
                          description="Maximum Git history depth for shallow clones."
                        >
                          <Input
                            type="number"
                            min={1}
                            max={100}
                            value={String(form.settings.cloneDepth)}
                            disabled={!canManage}
                            onChange={(event) =>
                              updateSettings({ cloneDepth: Number(event.target.value) })
                            }
                          />
                        </SettingsControlRow>
                        <SettingsControlRow
                          title="Max Size"
                          description="Maximum repository size allowed for sandbox clones."
                          help="Value is MiB and limits the downloaded repository archive. A clone is aborted when the archive exceeds this size."
                        >
                          <Input
                            type="number"
                            min={1}
                            max={102400}
                            value={String(form.settings.cloneMaxSizeMb)}
                            disabled={!canManage}
                            onChange={(event) =>
                              updateSettings({ cloneMaxSizeMb: Number(event.target.value) })
                            }
                          />
                        </SettingsControlRow>
                        <SettingsControlRow
                          title="Clone Timeout"
                          description="Maximum time allowed for Git clone operations."
                          help="Value is seconds. Gateway aborts the repository download when this duration is exceeded."
                        >
                          <Input
                            type="number"
                            min={10}
                            max={3600}
                            value={String(form.settings.cloneTimeoutSeconds)}
                            disabled={!canManage}
                            onChange={(event) =>
                              updateSettings({ cloneTimeoutSeconds: Number(event.target.value) })
                            }
                          />
                        </SettingsControlRow>
                        <SettingsControlRow
                          title="Shallow Clone"
                          description="Use shallow clones when full history is not required."
                        >
                          <Switch
                            checked={form.settings.cloneShallow}
                            disabled={!canManage}
                            onChange={(checked) => updateSettings({ cloneShallow: checked })}
                          />
                        </SettingsControlRow>
                        <SettingsControlRow
                          title="Clone LFS"
                          description="Fetch Git LFS objects during repository clone."
                        >
                          <Switch
                            checked={form.settings.cloneLfs}
                            disabled={!canManage}
                            onChange={(checked) => updateSettings({ cloneLfs: checked })}
                          />
                        </SettingsControlRow>
                        <SettingsControlRow
                          title="Clone Submodules"
                          description="Initialize and fetch repository submodules."
                        >
                          <Switch
                            checked={form.settings.cloneSubmodules}
                            disabled={!canManage}
                            onChange={(checked) => updateSettings({ cloneSubmodules: checked })}
                          />
                        </SettingsControlRow>
                      </PanelShell>
                    </motion.div>
                  )}

                  {dialogStep === 4 && (
                    <motion.div
                      key="gitlab-connector-step-4"
                      {...CONNECTOR_STEP_ANIMATION}
                      className="space-y-4"
                    >
                      <div className="divide-y divide-border border border-border">
                        <ReviewRow label="Name" value={form.name || "Not set"} />
                        <ReviewRow label="Base URL" value={form.baseUrl || "Not set"} />
                        <ReviewRow
                          label="Project Access"
                          value={
                            form.allowlistMode === "all_visible"
                              ? "All visible projects"
                              : `${form.allowlistEntries.length} selected`
                          }
                        />
                        <ReviewRow
                          label="Auto Sync"
                          value={
                            form.settings.autoSyncEnabled
                              ? `Every ${formatSyncInterval(form.settings.autoSyncIntervalSeconds)}`
                              : "Disabled"
                          }
                        />
                        <ReviewRow
                          label="Clone Limits"
                          value={`${form.settings.cloneDepth} depth · ${form.settings.cloneMaxSizeMb} MB · ${form.settings.cloneTimeoutSeconds}s`}
                        />
                      </div>
                      {editingConnector && (
                        <div className="border border-border p-3">
                          <p className="text-sm font-medium">Capabilities</p>
                          <CapabilityBadges
                            capabilities={editingConnector.capabilities}
                            className="mt-3"
                          />
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </ConnectorStepHeight>
            </div>
          )}

          <DialogFooter className="mt-4 shrink-0">
            {dialogStep === firstDialogStep ? (
              <>
                <Button variant="ghost" onClick={closeDialog} disabled={saving}>
                  {canManage ? "Cancel" : "Close"}
                </Button>
                {canManage && (
                  <Button
                    onClick={() => void goNext()}
                    disabled={
                      loadingDetail ||
                      testingConnection ||
                      refreshingAllowlist ||
                      (dialogStep === 1 && !canContinueFromConnection()) ||
                      (dialogStep === 2 && !canContinueFromAccessSelection())
                    }
                  >
                    Next <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={goBack} disabled={saving}>
                  <ArrowLeft className="mr-1 h-4 w-4" /> Back
                </Button>
                {dialogStep < lastDialogStep ? (
                  <Button
                    onClick={() => void goNext()}
                    disabled={
                      loadingDetail ||
                      refreshingAllowlist ||
                      (dialogStep === 2 && !canContinueFromAccessSelection())
                    }
                  >
                    Next <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                ) : (
                  <Button onClick={saveConnector} disabled={loadingDetail} pending={saving}>
                    {editingConnector ? "Save" : "Create Connector"}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConnectorRow({
  connector,
  canManage,
  testing,
  syncing,
  deleting,
  onOpen,
  onTest,
  onSync,
  onDelete,
}: {
  connector: GitLabConnector;
  canManage: boolean;
  testing: boolean;
  syncing: boolean;
  deleting: boolean;
  onOpen?: () => void;
  onTest: () => void;
  onSync: () => void;
  onDelete: () => void;
}) {
  const statusVariant = connector.enabled ? "secondary" : "outline";
  const lastSync = connector.syncFinishedAt ? (
    <>
      Synced <RelativeTime value={connector.syncFinishedAt} />
    </>
  ) : (
    "Never synced"
  );

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
          <Gitlab className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{connector.name}</p>
            <Badge variant={statusVariant} size="inline">
              {connector.enabled ? "enabled" : "disabled"}
            </Badge>
            <Badge
              variant={connector.syncStatus === "error" ? "destructive" : "outline"}
              size="inline"
            >
              {connector.syncStatus}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {connector.baseUrl} &middot;{" "}
            {connector.allowlistMode === "all_visible" ? "All visible" : "Selected"}
            {connector.tokenMasked ? ` · Token ${connector.tokenMasked}` : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {lastSync}
            {connector.testedAt && (
              <>
                {" · Tested "}
                <RelativeTime value={connector.testedAt} />
              </>
            )}
            {connector.syncLastError ? ` · ${connector.syncLastError}` : ""}
          </p>
          <CapabilityBadges capabilities={connector.capabilities} className="mt-2" />
        </div>
      </div>
      {canManage && (
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
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function formatSyncInterval(seconds: number) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  return "day";
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium sm:text-right">{value}</span>
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

import { ContentLoading } from "@/components/common/ContentLoading";
import { useContentLoading } from "@/components/common/reveal-gate";
import { LicenseFeatureBoundary } from "@/components/license/LicenseFeatureBoundary";
import { requireLicenseFeature } from "@/stores/license-paywall";
