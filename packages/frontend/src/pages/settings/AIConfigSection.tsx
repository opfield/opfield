import { Archive, Bot, Container, Cpu, Download, Eye, Gauge, Server, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { AIToolAccessModal } from "@/components/ai/AIToolAccessModal";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useSystemConfigStore } from "@/stores/system-config";
import type {
  AIInferenceModelOption,
  AIProviderType,
  AISandboxArtifact,
  AISandboxJob,
  AISandboxStatus,
} from "@/types/ai";
import { AgentSkillsPanel } from "./AgentSkillsPanel";
import { SaveSettingsButton, SettingsControlRow } from "./AISettingsControls";

interface AIConfigState {
  enabled: boolean;
  providerType: AIProviderType;
  providerUrl: string;
  endpointMode: string;
  supportsImages: boolean;
  model: string;
  gatewayInferenceModel: string;
  gatewayInferenceAllowUserModelSelection: boolean;
  allowUserReasoningEffortSelection: boolean;
  gatewayInferenceModels: AIInferenceModelOption[];
  maxCompletionTokens: number;
  maxTokensField: string;
  reasoningEffort: string;
  customSystemPrompt: string;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  maxToolRounds: number;
  maxContextTokens: number;
  disabledTools: string[];
  hasApiKey: boolean;
  apiKeyLast4: string;
  hasWebSearchKey: boolean;
  webSearchApiKeyLast4: string;
  webSearchProvider: string;
  webSearchBaseUrl: string;
  sandboxEnabled: boolean;
  sandboxDefaultTier: "low" | "medium" | "high";
}

function normalizeAIConfigState(config: AIConfigState): AIConfigState {
  return {
    ...config,
    providerType: config.providerType ?? "openai_compatible",
    gatewayInferenceModel: config.gatewayInferenceModel ?? "",
    gatewayInferenceAllowUserModelSelection: config.gatewayInferenceAllowUserModelSelection ?? true,
    allowUserReasoningEffortSelection: config.allowUserReasoningEffortSelection ?? false,
    gatewayInferenceModels: (config.gatewayInferenceModels ?? []).map((model) => ({
      ...model,
      reasoningEfforts: model.reasoningEfforts ?? [],
      defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    })),
  };
}

const WEB_SEARCH_PROVIDER_LABELS: Record<string, string> = {
  brave: "Brave Search",
  exa: "Exa",
  searxng: "SearXNG",
  serper: "Serper",
  tavily: "Tavily",
};

function formatExpires(value: string | null | undefined) {
  if (!value) return "-";
  const diffSeconds = Math.ceil((new Date(value).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(diffSeconds)) return "-";
  if (diffSeconds <= 0) return "expired";
  if (diffSeconds < 60) return `${diffSeconds}s`;
  const diffMinutes = Math.ceil(diffSeconds / 60);
  return `${diffMinutes}m`;
}

function SandboxStatusBadge({ status }: { status?: AISandboxStatus | null }) {
  if (!status) return null;
  const state = status?.state ?? "unknown";
  const active = state === "running";
  return <Badge variant={active ? "success" : "secondary"}>{state}</Badge>;
}

function SandboxJobsPanel() {
  const [jobs, setJobs] = useState<AISandboxJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [killingId, setKillingId] = useState<string | null>(null);
  const {
    open: outputOpen,
    value: outputJob,
    setValue: setOutputJob,
    onOpenChange: onOutputOpenChange,
  } = useDeferredDialogState<AISandboxJob>();
  const [outputText, setOutputText] = useState("");
  const [outputLoading, setOutputLoading] = useState(false);

  const loadJobs = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    try {
      setJobs(await api.listAISandboxJobs({ limit: 100, status: "running" }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load sandbox jobs");
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadJobs({ silent: true });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [loadJobs]);

  const killJob = async (job: AISandboxJob) => {
    setKillingId(job.id);
    try {
      await api.killAISandboxJob(job.id);
      toast.success("Sandbox job killed");
      await loadJobs({ silent: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to kill sandbox job");
    } finally {
      setKillingId(null);
    }
  };

  const viewOutput = async (job: AISandboxJob) => {
    setOutputJob(job);
    setOutputText("");
    setOutputLoading(true);
    try {
      const output = await api.getAISandboxJobOutput(job.id, 300);
      setOutputText(output.output || "(no output)");
    } catch (error) {
      setOutputText(error instanceof Error ? error.message : "Failed to load sandbox output");
    } finally {
      setOutputLoading(false);
    }
  };

  const columns: SimpleTableColumn<AISandboxJob>[] = [
    {
      id: "job",
      header: "Job",
      className: "w-[19rem]",
      cellClassName: "w-[19rem] max-w-[19rem]",
      render: (job) => (
        <div className="min-w-0 max-w-full">
          <p className="truncate font-mono text-xs" title={job.containerId ?? job.id}>
            {job.containerId ?? job.id}
          </p>
          <p className="truncate text-xs text-muted-foreground">{job.kind}</p>
        </div>
      ),
    },
    {
      id: "runtime",
      header: "Runtime",
      className: "w-24",
      cellClassName: "w-24 whitespace-nowrap",
      render: (job) => job.runtime,
    },
    {
      id: "tier",
      header: "Tier",
      className: "w-24",
      cellClassName: "w-24",
      render: (job) => <Badge variant="secondary">{job.resourceTier}</Badge>,
    },
    {
      id: "disk",
      header: "Disk",
      className: "w-28",
      cellClassName: "w-28 whitespace-nowrap",
      render: (job) => `${formatBytes(job.workspaceReservationBytes)} soft`,
    },
    {
      id: "status",
      header: "Status",
      className: "w-32",
      cellClassName: "w-32",
      render: (job) => (
        <Badge variant={job.status === "running" ? "success" : "secondary"}>{job.status}</Badge>
      ),
    },
    {
      id: "age",
      header: "Age",
      className: "w-28",
      cellClassName: "w-28 whitespace-nowrap",
      render: (job) => <RelativeTime value={job.createdAt} />,
    },
    {
      id: "expires",
      header: "Expires",
      className: "w-24",
      cellClassName: "w-24 whitespace-nowrap",
      render: (job) => formatExpires(job.expiresAt),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      className: "w-24",
      cellClassName: "w-24",
      render: (job) => (
        <div className="flex justify-end gap-1">
          {job.containerId && job.status === "running" && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="View output"
              onClick={(event) => {
                event.stopPropagation();
                viewOutput(job);
              }}
            >
              <Eye className="h-4 w-4" />
            </Button>
          )}
          {job.status === "running" || job.status === "queued" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Kill job"
              onClick={(event) => {
                event.stopPropagation();
                killJob(job);
              }}
              pending={killingId === job.id}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PanelShell
        title="Running Sandbox Jobs"
        description="Low-priority Docker sandboxes. Workspace reservations are soft; new jobs stop at 80% host-disk use."
        icon={<Container className="h-4 w-4" />}
        actions={<RefreshButton minDurationMs={1400} onClick={() => loadJobs({ silent: true })} />}
      >
        <SimpleTable
          columns={columns}
          rows={jobs}
          getRowKey={(job) => job.id}
          loading={loading}
          emptyMessage="No running sandbox jobs"
          tableClassName="table-fixed"
        />
      </PanelShell>
      <Dialog open={outputOpen} onOpenChange={onOutputOpenChange}>
        <DialogContent className="max-w-full overflow-x-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Sandbox Output</DialogTitle>
          </DialogHeader>
          <SandboxOutputBody
            loading={outputLoading}
            jobLabel={outputJob?.containerId ?? outputJob?.id}
            output={outputText}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function SandboxOutputBody({
  loading,
  jobLabel,
  output,
}: {
  loading: boolean;
  jobLabel: string | undefined;
  output: string;
}) {
  useContentLoading(loading);
  return (
    <div className="border border-border">
      <div className="border-b border-border px-4 py-3">
        <p className="truncate font-mono text-xs text-muted-foreground">{jobLabel}</p>
      </div>
      <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap px-4 py-3 text-xs">
        {output}
      </pre>
    </div>
  );
}

function openArtifactPreview(artifact: AISandboxArtifact) {
  const params = new URLSearchParams({ filename: artifact.filename });
  if (artifact.mediaType) params.set("mediaType", artifact.mediaType);
  window.open(
    `/ai/artifact/${encodeURIComponent(artifact.id)}?${params.toString()}`,
    `artifact-${artifact.id}`,
    "width=900,height=600,menubar=no,toolbar=no"
  );
}

/** The first page of the artifacts dialog holds it; later pages load in place. */
function AllArtifactsBody({ loading, children }: { loading: boolean; children: ReactNode }) {
  useContentLoading(loading);
  return <>{children}</>;
}

function SandboxArtifactsPanel() {
  const [artifacts, setArtifacts] = useState<AISandboxArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [allArtifacts, setAllArtifacts] = useState<AISandboxArtifact[]>([]);
  const [allLoading, setAllLoading] = useState(false);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const allRequestId = useRef(0);
  const loadingMore = useRef(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadArtifacts = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    try {
      const result = await api.listAISandboxArtifacts({ page: 1, limit: 10 });
      setArtifacts(result.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load artifacts");
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadArtifacts();
  }, [loadArtifacts]);

  const loadAllPage = useCallback(async (page: number, replace: boolean) => {
    if (!replace && loadingMore.current) return;
    const requestId = ++allRequestId.current;
    if (replace) {
      setAllArtifacts([]);
      setNextPage(null);
    } else {
      loadingMore.current = true;
    }
    setAllLoading(true);
    try {
      const result = await api.listAISandboxArtifacts({ page, limit: 25 });
      if (requestId !== allRequestId.current) return;
      setAllArtifacts((current) => (replace ? result.data : [...current, ...result.data]));
      setNextPage(result.nextPage);
    } catch (error) {
      if (requestId === allRequestId.current) {
        toast.error(error instanceof Error ? error.message : "Failed to load artifacts");
      }
    } finally {
      if (requestId === allRequestId.current) {
        loadingMore.current = false;
        setAllLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (allOpen) void loadAllPage(1, true);
  }, [allOpen, loadAllPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = tableScrollRef.current;
    if (!allOpen || !sentinel || !root || !nextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore.current) {
          void loadAllPage(nextPage, false);
        }
      },
      { root, rootMargin: "320px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [allOpen, loadAllPage, nextPage]);

  const onAllOpenChange = (open: boolean) => {
    setAllOpen(open);
    if (!open) {
      allRequestId.current += 1;
      loadingMore.current = false;
    }
  };

  const openAll = () => {
    allRequestId.current += 1;
    loadingMore.current = false;
    setAllArtifacts([]);
    setNextPage(null);
    setAllLoading(true);
    setAllOpen(true);
  };

  const deleteArtifact = async (artifact: AISandboxArtifact) => {
    setDeletingId(artifact.id);
    try {
      await api.deleteAISandboxArtifact(artifact.id);
      toast.success("Artifact deleted");
      await loadArtifacts({ silent: true });
      if (allOpen) await loadAllPage(1, true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete artifact");
    } finally {
      setDeletingId(null);
    }
  };

  const columns: SimpleTableColumn<AISandboxArtifact>[] = [
    {
      id: "artifact",
      header: "Artifact",
      className: "min-w-[14rem]",
      cellClassName: "min-w-[14rem]",
      render: (artifact) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={artifact.filename}>
            {artifact.filename}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={artifact.mediaType}>
            {artifact.mediaType || "application/octet-stream"}
          </p>
        </div>
      ),
    },
    {
      id: "chat",
      header: "Chat",
      className: "min-w-[14rem]",
      cellClassName: "min-w-[14rem]",
      render: (artifact) => (
        <div className="min-w-0">
          <p
            className="truncate text-sm"
            title={artifact.conversationTitle ?? artifact.conversationId ?? ""}
          >
            {artifact.conversationTitle ??
              (artifact.conversationId ? artifact.conversationId : "-")}
          </p>
          {artifact.conversationTitle && artifact.conversationId ? (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {artifact.conversationId}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      id: "size",
      header: "Size",
      className: "w-28",
      cellClassName: "w-28 whitespace-nowrap",
      render: (artifact) => formatBytes(artifact.sizeBytes),
    },
    {
      id: "created",
      header: "Created",
      className: "w-44",
      cellClassName: "w-44 whitespace-nowrap",
      render: (artifact) => <RelativeTime value={artifact.createdAt} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      className: "w-32",
      cellClassName: "w-32",
      render: (artifact) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              openArtifactPreview(artifact);
            }}
            aria-label={`Preview ${artifact.filename}`}
          >
            <Eye className="h-4 w-4" />
          </Button>
          <Button asChild variant="ghost" size="icon" aria-label={`Download ${artifact.filename}`}>
            <a
              href={artifact.downloadUrl}
              download={artifact.filename}
              onClick={(event) => event.stopPropagation()}
            >
              <Download className="h-4 w-4" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              deleteArtifact(artifact);
            }}
            pending={deletingId === artifact.id}
            aria-label={`Delete ${artifact.filename}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  const modalColumns: DataTableColumn<AISandboxArtifact>[] = [
    {
      key: "artifact",
      header: "Artifact",
      width: "minmax(14rem,1fr)",
      truncate: true,
      render: (artifact) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={artifact.filename}>
            {artifact.filename}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={artifact.mediaType}>
            {artifact.mediaType || "application/octet-stream"}
          </p>
        </div>
      ),
    },
    {
      key: "chat",
      header: "Chat",
      width: "minmax(14rem,1fr)",
      truncate: true,
      render: (artifact) => (
        <div className="min-w-0">
          <p
            className="truncate text-sm"
            title={artifact.conversationTitle ?? artifact.conversationId ?? ""}
          >
            {artifact.conversationTitle ?? artifact.conversationId ?? "-"}
          </p>
          {artifact.conversationTitle && artifact.conversationId ? (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {artifact.conversationId}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: "size",
      header: "Size",
      width: "7rem",
      render: (artifact) => formatBytes(artifact.sizeBytes),
    },
    {
      key: "created",
      header: "Created",
      width: "11rem",
      render: (artifact) => <RelativeTime value={artifact.createdAt} />,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "8rem",
      render: (artifact) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              openArtifactPreview(artifact);
            }}
            aria-label={`Preview ${artifact.filename}`}
          >
            <Eye className="h-4 w-4" />
          </Button>
          <Button asChild variant="ghost" size="icon" aria-label={`Download ${artifact.filename}`}>
            <a
              href={artifact.downloadUrl}
              download={artifact.filename}
              onClick={(event) => event.stopPropagation()}
            >
              <Download className="h-4 w-4" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              void deleteArtifact(artifact);
            }}
            pending={deletingId === artifact.id}
            aria-label={`Delete ${artifact.filename}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  const modalTableHeight = allArtifacts.length
    ? Math.min(49 + allArtifacts.length * 49 + 44, 640)
    : undefined;

  return (
    <>
      <PanelShell
        title="Stored Artifacts"
        description="The 10 most recently retained files from assistant sandbox runs"
        icon={<Archive className="h-4 w-4" />}
        actions={
          <div className="flex items-center gap-3">
            <Button variant="quiet" size="inline" className="text-sm font-normal" onClick={openAll}>
              View all
            </Button>
            <RefreshButton minDurationMs={1400} onClick={() => loadArtifacts({ silent: true })} />
          </div>
        }
      >
        <SimpleTable
          columns={columns}
          rows={artifacts}
          getRowKey={(artifact) => artifact.id}
          loading={loading}
          emptyMessage="No stored artifacts"
          tableClassName="table-fixed"
          onRowClick={openArtifactPreview}
        />
      </PanelShell>

      <Dialog open={allOpen} onOpenChange={onAllOpenChange}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-h-[85dvh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Stored Artifacts</DialogTitle>
            <DialogDescription>
              All retained assistant sandbox files. Scroll to load older artifacts.
            </DialogDescription>
          </DialogHeader>
          <AllArtifactsBody loading={allLoading && allArtifacts.length === 0}>
            <div
              className="max-h-[min(65dvh,40rem)]"
              style={modalTableHeight ? { height: modalTableHeight } : undefined}
            >
              <DataTable
                columns={modalColumns}
                data={allArtifacts}
                keyFn={(artifact) => artifact.id}
                onRowClick={openArtifactPreview}
                horizontalScroll
                minWidth="56rem"
                className="h-full"
                scrollRef={tableScrollRef}
                emptyMessage="No stored artifacts"
                footer={
                  nextPage ? (
                    <div
                      ref={sentinelRef}
                      className="py-3 text-center text-xs text-muted-foreground"
                    >
                      {allLoading ? "Loading more…" : "Scroll to load older artifacts"}
                    </div>
                  ) : allArtifacts.length > 0 ? (
                    <div className="py-3 text-center text-xs text-muted-foreground">
                      End of artifacts
                    </div>
                  ) : null
                }
              />
            </div>
          </AllArtifactsBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AIConfigSection() {
  const inferenceEnabled = useSystemConfigStore((state) => state.config.features.inferenceEnabled);
  const [aiConfig, setAiConfig] = useState<AIConfigState | null>(() => {
    const cached = api.getCached<AIConfigState>("settings:ai-config");
    return cached ? normalizeAIConfigState(cached) : null;
  });
  const [initialLoadComplete, setInitialLoadComplete] = useState(aiConfig !== null);
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiWebSearchKey, setAiWebSearchKey] = useState("");
  const [aiToolsModalOpen, setAiToolsModalOpen] = useState(false);
  const [sandboxStatus, setSandboxStatus] = useState<AISandboxStatus | null>(null);
  const [sandboxStatusLoaded, setSandboxStatusLoaded] = useState(false);
  // The panel whose save is running; every save stays disabled meanwhile.
  const [aiSavingSection, setAiSavingSection] = useState<string | null>(null);
  const aiSaving = aiSavingSection !== null;
  const [aiSavedConfig, setAiSavedConfig] = useState<AIConfigState | null>(() => {
    const cached = api.getCached<AIConfigState>("settings:ai-config");
    return cached ? normalizeAIConfigState(cached) : null;
  });

  const assistantHasChanges = (() => {
    if (!aiConfig || !aiSavedConfig) return false;
    if (aiWebSearchKey) return true;
    return (
      aiConfig.enabled !== aiSavedConfig.enabled ||
      aiConfig.customSystemPrompt !== aiSavedConfig.customSystemPrompt ||
      aiConfig.webSearchProvider !== aiSavedConfig.webSearchProvider ||
      aiConfig.webSearchBaseUrl !== aiSavedConfig.webSearchBaseUrl ||
      JSON.stringify(aiConfig.disabledTools) !== JSON.stringify(aiSavedConfig.disabledTools)
    );
  })();

  const providerHasChanges = (() => {
    if (!aiConfig || !aiSavedConfig) return false;
    if (aiApiKey) return true;
    return (
      aiConfig.providerUrl !== aiSavedConfig.providerUrl ||
      aiConfig.providerType !== aiSavedConfig.providerType ||
      aiConfig.endpointMode !== aiSavedConfig.endpointMode ||
      aiConfig.supportsImages !== aiSavedConfig.supportsImages ||
      aiConfig.model !== aiSavedConfig.model ||
      aiConfig.gatewayInferenceModel !== aiSavedConfig.gatewayInferenceModel ||
      aiConfig.gatewayInferenceAllowUserModelSelection !==
        aiSavedConfig.gatewayInferenceAllowUserModelSelection ||
      aiConfig.reasoningEffort !== aiSavedConfig.reasoningEffort ||
      aiConfig.allowUserReasoningEffortSelection !== aiSavedConfig.allowUserReasoningEffortSelection
    );
  })();

  const limitsHasChanges = (() => {
    if (!aiConfig || !aiSavedConfig) return false;
    return (
      aiConfig.maxCompletionTokens !== aiSavedConfig.maxCompletionTokens ||
      aiConfig.maxTokensField !== aiSavedConfig.maxTokensField ||
      aiConfig.rateLimitMax !== aiSavedConfig.rateLimitMax ||
      aiConfig.rateLimitWindowSeconds !== aiSavedConfig.rateLimitWindowSeconds ||
      aiConfig.maxToolRounds !== aiSavedConfig.maxToolRounds ||
      aiConfig.maxContextTokens !== aiSavedConfig.maxContextTokens
    );
  })();

  const sandboxHasChanges = (() => {
    if (!aiConfig || !aiSavedConfig) return false;
    return (
      aiConfig.sandboxEnabled !== aiSavedConfig.sandboxEnabled ||
      aiConfig.sandboxDefaultTier !== aiSavedConfig.sandboxDefaultTier
    );
  })();

  const loadAIConfig = useCallback(async () => {
    const expectedInferenceEnabled = inferenceEnabled;
    try {
      const config = normalizeAIConfigState((await api.getAIConfig()) as unknown as AIConfigState);
      if (
        useSystemConfigStore.getState().config.features.inferenceEnabled !==
        expectedInferenceEnabled
      ) {
        return;
      }
      api.setCache("settings:ai-config", config);
      setAiConfig(config);
      setAiSavedConfig(config);
    } catch {
      /* AI not configured yet */
    } finally {
      setInitialLoadComplete(true);
    }
  }, [inferenceEnabled]);

  const loadSandboxStatus = useCallback(async () => {
    try {
      setSandboxStatus(await api.getAISandboxStatus());
    } catch {
      setSandboxStatus(null);
    } finally {
      setSandboxStatusLoaded(true);
    }
  }, []);

  const updateAIConfig = async (partial: Record<string, unknown>, section: string) => {
    setAiSavingSection(section);
    try {
      const updated = normalizeAIConfigState(
        (await api.updateAIConfig(partial)) as unknown as AIConfigState
      );
      setAiConfig((prev) => {
        if (!prev) return null;
        const next = { ...prev, ...updated };
        api.setCache("settings:ai-config", next);
        setAiSavedConfig(next);
        return next;
      });
      api
        .getAIStatus()
        .then((status) => useAIStore.getState().setProviderStatus(status))
        .catch(() => {});
      toast.success("AI settings updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update AI settings");
    } finally {
      setAiSavingSection(null);
    }
  };

  const saveAssistantSettings = async () => {
    if (!aiConfig) return;
    const updates: Record<string, unknown> = {
      enabled: aiConfig.enabled,
      customSystemPrompt: aiConfig.customSystemPrompt,
      disabledTools: aiConfig.disabledTools,
      webSearchProvider: aiConfig.webSearchProvider,
      webSearchBaseUrl: aiConfig.webSearchBaseUrl,
    };
    if (aiWebSearchKey) updates.webSearchApiKey = aiWebSearchKey;
    await updateAIConfig(updates, "assistant");
    setAiWebSearchKey("");
  };

  const saveProviderSettings = async () => {
    if (!aiConfig) return;
    const updates: Record<string, unknown> =
      aiConfig.providerType === "gateway_inference"
        ? {
            providerType: aiConfig.providerType,
            gatewayInferenceModel: aiConfig.gatewayInferenceModel,
            gatewayInferenceAllowUserModelSelection:
              aiConfig.gatewayInferenceAllowUserModelSelection,
          }
        : {
            providerType: aiConfig.providerType,
            providerUrl: aiConfig.providerUrl,
            endpointMode: aiConfig.endpointMode,
            supportsImages: aiConfig.supportsImages,
            model: aiConfig.model,
            reasoningEffort: aiConfig.reasoningEffort,
            allowUserReasoningEffortSelection: aiConfig.allowUserReasoningEffortSelection,
          };
    if (aiConfig.providerType === "openai_compatible" && aiApiKey) {
      updates.apiKey = aiApiKey;
    }
    await updateAIConfig(updates, "provider");
    setAiApiKey("");
  };

  const saveLimitSettings = async () => {
    if (!aiConfig) return;
    await updateAIConfig(
      {
        maxCompletionTokens: aiConfig.maxCompletionTokens,
        maxTokensField: aiConfig.maxTokensField,
        rateLimitMax: aiConfig.rateLimitMax,
        rateLimitWindowSeconds: aiConfig.rateLimitWindowSeconds,
        maxToolRounds: aiConfig.maxToolRounds,
        maxContextTokens: aiConfig.maxContextTokens,
      },
      "limits"
    );
  };

  const saveSandboxSettings = async () => {
    if (!aiConfig) return;
    await updateAIConfig(
      {
        sandboxEnabled: aiConfig.sandboxEnabled,
        sandboxDefaultTier: aiConfig.sandboxDefaultTier,
      },
      "sandbox"
    );
  };

  const setToolDisabled = (toolName: string, disabled: boolean) => {
    if (!aiConfig) return;
    const disabledTools = new Set(aiConfig.disabledTools);
    if (disabled) disabledTools.add(toolName);
    else disabledTools.delete(toolName);
    setAiConfig({ ...aiConfig, disabledTools: Array.from(disabledTools) });
  };

  useEffect(() => {
    loadAIConfig();
  }, [loadAIConfig]);

  useEffect(() => {
    if (aiConfig?.sandboxEnabled) loadSandboxStatus();
  }, [aiConfig?.sandboxEnabled, loadSandboxStatus]);

  // The sandbox runtime badge follows the config, so its status is part of the first render.
  useContentLoading(
    !initialLoadComplete || (aiConfig?.sandboxEnabled === true && !sandboxStatusLoaded)
  );
  if (!initialLoadComplete || !aiConfig) return null;
  const webSearchEnabled = !aiConfig.disabledTools.includes("web_search");

  return (
    <>
      <PanelShell
        icon={<Bot className="h-4 w-4" />}
        title="AI Workspace"
        description="Configure the Workspace model connection for intent-driven operations"
        actions={
          <SaveSettingsButton
            onClick={saveAssistantSettings}
            pending={aiSavingSection === "assistant"}
            disabled={!assistantHasChanges || aiSaving}
          />
        }
        dirty={assistantHasChanges}
      >
        <SettingsControlRow
          title="Enabled"
          description="Enable AI Workspace for users who have Workspace access."
          controlsClassName="flex justify-end justify-self-end !w-auto !min-w-0 !max-w-none"
        >
          <Switch
            checked={aiConfig.enabled}
            disabled={aiSaving}
            onChange={(enabled) => setAiConfig({ ...aiConfig, enabled })}
          />
        </SettingsControlRow>
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <div className="flex flex-col border-r border-border max-lg:border-r-0 max-lg:border-b">
            <div className="border-b border-border bg-muted p-4">
              <h3 className="text-sm font-semibold">System Prompt</h3>
              <p className="text-xs text-muted-foreground">
                Add durable instructions that are prepended to Work Sessions.
              </p>
            </div>
            <Textarea
              className="min-h-[16rem] flex-1 resize-none border-0"
              placeholder="Add custom instructions for AI Workspace.&#10;&#10;Examples:&#10;- Company PKI policies and naming conventions&#10;- Preferred certificate settings&#10;- Security guidelines"
              value={aiConfig.customSystemPrompt}
              onChange={(e) => setAiConfig({ ...aiConfig, customSystemPrompt: e.target.value })}
            />
          </div>
          <div className="flex flex-col">
            <div className="border-b border-border bg-muted p-4">
              <h3 className="text-sm font-semibold">Tools</h3>
              <p className="text-xs text-muted-foreground">
                Configure AI Workspace tool access and an optional web search provider.
              </p>
            </div>
            <SettingsControlRow
              title="Tool Access"
              description={
                aiConfig.disabledTools.length > 0
                  ? `${aiConfig.disabledTools.length} tool${aiConfig.disabledTools.length !== 1 ? "s" : ""} disabled`
                  : "All tools enabled"
              }
              help="Controls which Gateway operations the assistant is allowed to invoke. Disabling a tool removes that capability from every AI Workspace conversation."
              controlsClassName="sm:min-w-0"
            >
              <Button
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => setAiToolsModalOpen(true)}
              >
                Manage
              </Button>
            </SettingsControlRow>
            <SettingsControlRow
              title="Enable web search"
              description="Expose web search tools to AI Workspace."
              controlsClassName="flex justify-end justify-self-end !w-auto !min-w-0 !max-w-none"
            >
              <Switch
                checked={webSearchEnabled}
                disabled={aiSaving}
                onChange={(enabled) => setToolDisabled("web_search", !enabled)}
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Web search provider"
              description="Provider used when web search is enabled."
              controlsClassName="sm:max-w-[22rem]"
            >
              <Select
                value={aiConfig.webSearchProvider || "tavily"}
                onValueChange={(v) => setAiConfig({ ...aiConfig, webSearchProvider: v })}
                disabled={!webSearchEnabled}
              >
                <SelectTrigger aria-label="Web search provider" className="text-sm">
                  <SelectValue>
                    {WEB_SEARCH_PROVIDER_LABELS[aiConfig.webSearchProvider || "tavily"] ??
                      aiConfig.webSearchProvider}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tavily">Tavily — AI-optimized search</SelectItem>
                  <SelectItem value="brave">Brave Search — privacy-first</SelectItem>
                  <SelectItem value="serper">Serper — Google results</SelectItem>
                  <SelectItem value="exa">Exa — semantic search</SelectItem>
                  <SelectItem value="searxng">SearXNG — local deployment</SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
            {aiConfig.webSearchProvider === "searxng" ? (
              <SettingsControlRow
                title="Instance URL"
                description="Base URL of the SearXNG instance."
              >
                <Input
                  aria-label="SearXNG instance URL"
                  className="text-sm"
                  placeholder="https://searxng.example.com"
                  value={aiConfig.webSearchBaseUrl}
                  disabled={!webSearchEnabled}
                  onChange={(e) => setAiConfig({ ...aiConfig, webSearchBaseUrl: e.target.value })}
                />
              </SettingsControlRow>
            ) : (
              <SettingsControlRow
                title="Web search API key"
                description="Secret used by the selected web search provider."
              >
                <Input
                  aria-label="Web search API key"
                  className="text-sm"
                  type="password"
                  placeholder={
                    aiConfig.hasWebSearchKey
                      ? aiConfig.webSearchApiKeyLast4
                        ? `****${aiConfig.webSearchApiKeyLast4}`
                        : "Configured — enter new to replace"
                      : "Enter API key"
                  }
                  value={aiWebSearchKey}
                  disabled={!webSearchEnabled}
                  onChange={(e) => setAiWebSearchKey(e.target.value)}
                />
              </SettingsControlRow>
            )}
          </div>
        </div>
      </PanelShell>

      <AgentSkillsPanel />

      <div className="space-y-4">
        <PanelShell
          icon={<Server className="h-4 w-4" />}
          title="Provider"
          description={
            aiConfig.providerType === "gateway_inference"
              ? "Gateway Inference model used for Workspace responses"
              : "OpenAI-compatible provider connection used for Workspace responses"
          }
          actions={
            <SaveSettingsButton
              onClick={saveProviderSettings}
              pending={aiSavingSection === "provider"}
              disabled={
                !providerHasChanges ||
                aiSaving ||
                (aiConfig.providerType === "gateway_inference" && !aiConfig.gatewayInferenceModel)
              }
            />
          }
          dirty={providerHasChanges}
        >
          <SettingsControlRow
            title="Provider type"
            description={
              <>
                Response provider for AI Workspace.
                {!inferenceEnabled && (
                  <>
                    {" "}
                    To use Gateway Inference and subscription providers,{" "}
                    <Link
                      to="/settings/general"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      enable and configure Inference in General settings
                    </Link>
                    .
                  </>
                )}
              </>
            }
            help="Gateway Inference uses the centrally managed provider and model catalog. OAI-compatible connects AI Workspace directly to one configured API endpoint."
          >
            <Select
              value={aiConfig.providerType || "openai_compatible"}
              onValueChange={(providerType) =>
                setAiConfig({
                  ...aiConfig,
                  providerType: providerType as AIProviderType,
                  gatewayInferenceModel:
                    providerType === "gateway_inference"
                      ? aiConfig.gatewayInferenceModel ||
                        aiConfig.gatewayInferenceModels[0]?.id ||
                        ""
                      : aiConfig.gatewayInferenceModel,
                })
              }
            >
              <SelectTrigger aria-label="Provider type" className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai_compatible">OAI-compatible</SelectItem>
                {inferenceEnabled && (
                  <SelectItem value="gateway_inference">Gateway Inference</SelectItem>
                )}
              </SelectContent>
            </Select>
          </SettingsControlRow>
          {aiConfig.providerType === "gateway_inference" ? (
            <>
              <SettingsControlRow
                title="Default model"
                description="Model used unless an operator selects another allowed model."
              >
                <Select
                  value={aiConfig.gatewayInferenceModel}
                  onValueChange={(gatewayInferenceModel) =>
                    setAiConfig({ ...aiConfig, gatewayInferenceModel })
                  }
                >
                  <SelectTrigger aria-label="Default model" className="text-sm">
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {aiConfig.gatewayInferenceModels.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsControlRow>
              <SettingsControlRow
                title="User model selection"
                description="Allow users to choose another Gateway Inference model they can access."
              >
                <Switch
                  checked={aiConfig.gatewayInferenceAllowUserModelSelection}
                  disabled={aiSaving}
                  onChange={(gatewayInferenceAllowUserModelSelection) =>
                    setAiConfig({
                      ...aiConfig,
                      gatewayInferenceAllowUserModelSelection,
                    })
                  }
                />
              </SettingsControlRow>
            </>
          ) : (
            <>
              <SettingsControlRow title="Base URL" description="OpenAI-compatible API base URL.">
                <Input
                  aria-label="Base URL"
                  className="text-sm"
                  placeholder="https://api.openai.com/v1"
                  value={aiConfig.providerUrl}
                  onChange={(e) => setAiConfig({ ...aiConfig, providerUrl: e.target.value })}
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Endpoint"
                description="Provider endpoint family used for tool-capable requests."
                help="Auto uses the Responses API for OpenAI hosts and Chat Completions for other OpenAI-compatible hosts. Force a mode only when the provider requires it."
              >
                <Select
                  value={aiConfig.endpointMode || "auto"}
                  onValueChange={(endpointMode) => setAiConfig({ ...aiConfig, endpointMode })}
                >
                  <SelectTrigger aria-label="Endpoint" className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="responses">Responses API</SelectItem>
                    <SelectItem value="chat_completions">Chat Completions</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsControlRow>
              <SettingsControlRow
                title="Image input"
                description="Enable when the selected model can process uploaded images."
              >
                <Switch
                  checked={!!aiConfig.supportsImages}
                  disabled={aiSaving}
                  onChange={(supportsImages) => setAiConfig({ ...aiConfig, supportsImages })}
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Model"
                description="Model name used for Workspace responses."
              >
                <Input
                  aria-label="Model"
                  className="text-sm"
                  placeholder="gpt-4o"
                  value={aiConfig.model}
                  onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })}
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Default reasoning effort"
                description="Reasoning effort used unless a user selects another value."
                help="Reasoning effort controls how much internal computation a compatible model may use before answering. Higher levels can improve difficult work but increase latency and usage."
                controlsClassName="sm:max-w-none"
              >
                <Tabs
                  value={aiConfig.reasoningEffort}
                  onValueChange={(reasoningEffort) => setAiConfig({ ...aiConfig, reasoningEffort })}
                  className="w-full"
                >
                  <TabsList className="w-full">
                    {(["none", "low", "medium", "high"] as const).map((level) => (
                      <TabsTrigger key={level} value={level} className="flex-1 capitalize">
                        {level === "none" ? "Default" : level}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </SettingsControlRow>
              <SettingsControlRow
                title="User reasoning selection"
                description="Allow users to override the default reasoning effort in AI chats."
              >
                <Switch
                  checked={aiConfig.allowUserReasoningEffortSelection}
                  disabled={aiSaving}
                  onChange={(allowUserReasoningEffortSelection) =>
                    setAiConfig({
                      ...aiConfig,
                      allowUserReasoningEffortSelection,
                    })
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="API key"
                description="Secret used to authenticate provider requests."
              >
                <Input
                  aria-label="API key"
                  className="text-sm"
                  type="password"
                  placeholder={aiConfig.hasApiKey ? `****${aiConfig.apiKeyLast4}` : "sk-..."}
                  value={aiApiKey}
                  onChange={(e) => setAiApiKey(e.target.value)}
                />
              </SettingsControlRow>
            </>
          )}
        </PanelShell>

        {aiConfig.providerType === "openai_compatible" && (
          <PanelShell
            icon={<Gauge className="h-4 w-4" />}
            title="Limits"
            description="Request budgets, context size, and provider token field mapping"
            actions={
              <SaveSettingsButton
                onClick={saveLimitSettings}
                pending={aiSavingSection === "limits"}
                disabled={!limitsHasChanges || aiSaving}
              />
            }
            dirty={limitsHasChanges}
          >
            <SettingsControlRow
              title="Requests and window"
              description="Maximum Workspace requests allowed per time window."
              help="The first value is the maximum request count; the second is the window duration in seconds."
              controlsClassName="grid grid-cols-2 gap-2 sm:max-w-none sm:grid-cols-[8rem_8rem]"
            >
              <Input
                aria-label="Requests"
                className="text-sm"
                type="number"
                value={aiConfig.rateLimitMax}
                onChange={(e) => setAiConfig({ ...aiConfig, rateLimitMax: Number(e.target.value) })}
              />
              <Input
                aria-label="Window seconds"
                className="text-sm"
                type="number"
                value={aiConfig.rateLimitWindowSeconds}
                onChange={(e) =>
                  setAiConfig({
                    ...aiConfig,
                    rateLimitWindowSeconds: Number(e.target.value),
                  })
                }
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Tool rounds and context size"
              description="Maximum sequential tool calls and context budget."
              help="The first value caps sequential tool-call rounds in one run; the second is the conversation-builder token budget."
              controlsClassName="grid grid-cols-2 gap-2 sm:max-w-none sm:grid-cols-[8rem_8rem]"
            >
              <Input
                aria-label="Max tool rounds"
                className="text-sm"
                type="number"
                value={aiConfig.maxToolRounds}
                onChange={(e) =>
                  setAiConfig({ ...aiConfig, maxToolRounds: Number(e.target.value) })
                }
              />
              <Input
                aria-label="Context size"
                className="text-sm"
                type="number"
                value={aiConfig.maxContextTokens}
                onChange={(e) =>
                  setAiConfig({ ...aiConfig, maxContextTokens: Number(e.target.value) })
                }
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Response tokens"
              description="Maximum generated tokens returned by the provider."
              help="Caps the length of the model's generated answer. It does not include the input conversation or tool results already present in context."
            >
              <Input
                aria-label="Max response tokens"
                className="text-sm"
                type="number"
                value={aiConfig.maxCompletionTokens}
                onChange={(e) =>
                  setAiConfig({ ...aiConfig, maxCompletionTokens: Number(e.target.value) })
                }
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Token field"
              description="Provider request field used for max response tokens."
              help="Use max_completion_tokens for providers supporting the newer field; select max_tokens when a compatible provider rejects it."
            >
              <Select
                value={aiConfig.maxTokensField || "max_completion_tokens"}
                onValueChange={(v) => setAiConfig({ ...aiConfig, maxTokensField: v })}
              >
                <SelectTrigger aria-label="Token field" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="max_completion_tokens">max_completion_tokens</SelectItem>
                  <SelectItem value="max_tokens">max_tokens</SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
          </PanelShell>
        )}
      </div>

      <PanelShell
        icon={<Cpu className="h-4 w-4" />}
        title="Sandbox Runner"
        description="Run bounded agent commands in Docker sandboxes"
        actions={
          <SaveSettingsButton
            onClick={saveSandboxSettings}
            pending={aiSavingSection === "sandbox"}
            disabled={!sandboxHasChanges || aiSaving}
          />
        }
        dirty={sandboxHasChanges}
      >
        <SettingsControlRow
          title="Enabled"
          description="Expose sandbox execution tools to AI Workspace."
          controlsClassName="flex justify-end justify-self-end !w-auto !min-w-0 !max-w-none"
        >
          <Switch
            checked={aiConfig.sandboxEnabled}
            disabled={aiSaving}
            onChange={(sandboxEnabled) => setAiConfig({ ...aiConfig, sandboxEnabled })}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Default tier"
          description="Default resource tier used when the agent does not request one."
          help="The tier sets the default CPU, memory, maximum lifetime, and disk allowance for newly created assistant sandboxes."
          controlsClassName="sm:max-w-[28rem]"
        >
          <Select
            value={aiConfig.sandboxDefaultTier || "low"}
            onValueChange={(sandboxDefaultTier) =>
              setAiConfig({
                ...aiConfig,
                sandboxDefaultTier: sandboxDefaultTier as AIConfigState["sandboxDefaultTier"],
              })
            }
          >
            <SelectTrigger aria-label="Default sandbox tier" className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low — 0.25 CPU, 256 MB, 4 h max, 2 GB disk</SelectItem>
              <SelectItem value="medium">Medium — 0.5 CPU, 512 MB, 12 h max, 4 GB disk</SelectItem>
              <SelectItem value="high">High — 1 CPU, 1 GB, 24 h max, 6 GB disk</SelectItem>
            </SelectContent>
          </Select>
        </SettingsControlRow>
        <SettingsControlRow
          title="Runtime"
          description="Sandbox runner process status."
          help="Shows whether Gateway's sandbox worker is available to start isolated command-execution jobs for AI Workspace."
          controlsClassName="flex justify-end justify-self-end !w-auto !min-w-0 !max-w-none"
        >
          <SandboxStatusBadge status={sandboxStatus} />
        </SettingsControlRow>
      </PanelShell>

      <SandboxJobsPanel />
      <SandboxArtifactsPanel />

      <AIToolAccessModal
        open={aiToolsModalOpen}
        onOpenChange={setAiToolsModalOpen}
        disabledTools={aiConfig.disabledTools}
        onSave={(disabledTools) =>
          setAiConfig((current) => (current ? { ...current, disabledTools } : current))
        }
      />
    </>
  );
}
