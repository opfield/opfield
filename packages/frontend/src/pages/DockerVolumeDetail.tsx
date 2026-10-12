import {
  Boxes,
  Download,
  Hash,
  Save,
  Scaling,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/ui/stat-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { toastApiError } from "@/lib/api-error-toast";
import { canEditDockerVolume } from "@/lib/docker-volume-access";
import {
  dockerComposeProjectRoute,
  dockerContainerRoute,
  dockerVolumeRoute,
} from "@/lib/resource-routes";
import { createReturnNavigationState, getReturnNavigationTarget } from "@/lib/return-navigation";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { useUIStore } from "@/stores/ui";
import type { DockerVolume, DockerVolumeMetrics } from "@/types";
import { type FileManagerOperations, FilesTab } from "./docker-detail/FilesTab";
import { LabelsSection } from "./docker-detail/LabelsSection";
import { VolumeSpaceStatCard } from "./docker-detail/VolumeSpaceStatCard";

type LabelEntry = { key: string; value: string };
type VolumeUsageContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  canOpen: boolean;
};
const VOLUME_CLEANUP_PROTECTED_LABEL = "gateway.housekeeping.protected";

function labelsToEntries(labels: Record<string, string> | undefined): LabelEntry[] {
  return Object.entries(labels ?? {}).map(([key, value]) => ({ key, value }));
}

function labelsToRecord(labels: LabelEntry[]): Record<string, string> {
  return labels.reduce<Record<string, string>>((acc, label) => {
    const key = label.key.trim();
    if (key) acc[key] = label.value;
    return acc;
  }, {});
}

function labelsSignature(labels: LabelEntry[]) {
  return JSON.stringify(
    Object.entries(labelsToRecord(labels)).sort(([a], [b]) => a.localeCompare(b))
  );
}

export function DockerVolumeDetail({
  resolvedNodeId,
  resolvedNodeSlug,
  resolvedVolumeName,
}: {
  resolvedNodeId?: string;
  resolvedNodeSlug?: string;
  resolvedVolumeName?: string;
} = {}) {
  const params = useParams<{
    nodeId?: string;
    nodeSlug?: string;
    volumeName?: string;
    tab?: string;
  }>();
  const nodeId = resolvedNodeId ?? params.nodeId;
  const nodeSlug = resolvedNodeSlug ?? params.nodeSlug ?? params.nodeId ?? "";
  const volumeName = resolvedVolumeName ?? params.volumeName;
  const navigate = useStableNavigate();
  const location = useLocation();
  const backTarget = getReturnNavigationTarget(location.state, "/docker/volumes");
  const { hasScope } = useAuthStore();
  const decodedVolumeName = volumeName ?? "";
  const [activeTab, setActiveTab] = useUrlTab(["files", "settings"], "files", (tab) =>
    dockerVolumeRoute(nodeSlug, decodedVolumeName, tab)
  );
  const [volume, setVolume] = useState<DockerVolume | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  // The header action whose request is running, so its button shows the pending state.
  const [pendingAction, setPendingAction] = useState<"remove" | "protect" | null>(null);
  const [labelsSaving, setLabelsSaving] = useState(false);
  const [labels, setLabels] = useState<LabelEntry[]>([]);
  const [savedLabels, setSavedLabels] = useState<LabelEntry[]>([]);
  const [composeOwnerProjectId, setComposeOwnerProjectId] = useState<string | null>(null);
  const [composeOwnerLoadedFor, setComposeOwnerLoadedFor] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [usageContainers, setUsageContainers] = useState<VolumeUsageContainer[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);
  // The attachments a Usage table was filled for, so the Settings tab waits for its first rows.
  const [usageLoadedFor, setUsageLoadedFor] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<DockerVolumeMetrics | null>(null);
  const [metricsLoaded, setMetricsLoaded] = useState(false);
  const [metricHistory, setMetricHistory] = useState({
    space: [] as number[],
    inodes: [] as number[],
    attachments: [] as number[],
  });
  const [resizeOpen, setResizeOpen] = useState(false);
  const [resizeCapacityGb, setResizeCapacityGb] = useState("");
  const [resizing, setResizing] = useState(false);
  const metricsRequestRef = useRef<string | null>(null);
  const metricsIdentityRef = useRef("");
  const lastMetricCollectedAtRef = useRef<string | null>(null);
  metricsIdentityRef.current = `${nodeId ?? ""}:${decodedVolumeName}`;

  // Volume grants are per `<nodeId>/<volume>` (node and folder grants resolve to them), like the backend routes.
  const volumeScopeId = volume?.scopeResourceId ?? decodedVolumeName;
  const hasVolumeScope = (base: string) =>
    hasScope(base) || !!(nodeId && hasScope(`${base}:${nodeId}/${volumeScopeId}`));
  // Rename, labels and resize edit this one volume: the volume edit scope, never a per-volume create scope.
  const canEditVolume = canEditDockerVolume(hasScope, nodeId, volumeScopeId);
  const canDeleteVolume = hasVolumeScope("docker:volumes:delete");
  const canExportVolume = hasVolumeScope("docker:volumes:export");
  const canRenameVolume = canEditVolume;
  const isAnonymousVolume = /^[a-f0-9]{64}$/i.test(decodedVolumeName);
  const isCleanupProtected = volume?.labels?.[VOLUME_CLEANUP_PROTECTED_LABEL] === "true";
  const composeProjectName = volume?.labels?.["com.docker.compose.project"];
  const composeManaged = !!composeProjectName;
  const canReadVolumeFiles = hasVolumeScope("docker:volumes:files:read");
  const canWriteVolumeFiles = hasVolumeScope("docker:volumes:files:write");
  const unavailable = volume?.availability === "unavailable";
  const usedBy = useMemo<string[]>(() => {
    const raw = volume?.usedBy ?? (volume as any)?.UsedBy;
    return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : [];
  }, [volume]);
  const isUsed = usedBy.length > 0 || (volume?.usedByCount ?? 0) > 0;
  const labelsChanged = labelsSignature(labels) !== labelsSignature(savedLabels);
  const isDiskImage = volume?.storageKind === "disk-image";
  const currentCapacityGb = Math.max(
    1,
    Math.ceil((volume?.capacityBytes ?? metrics?.capacityBytes ?? 0) / 1024 ** 3)
  );
  const usageColumns = useMemo<SimpleTableColumn<VolumeUsageContainer>[]>(
    () => [
      {
        id: "container",
        header: "Container",
        render: (container) => <span className="font-mono">{container.name}</span>,
      },
      {
        id: "image",
        header: "Image",
        cellClassName: "font-mono text-muted-foreground",
        render: (container) => container.image || "-",
      },
      {
        id: "state",
        header: "State",
        align: "right",
        render: (container) =>
          container.state ? (
            <Badge variant={container.state === "running" ? "success" : "secondary"}>
              {container.state}
            </Badge>
          ) : (
            "-"
          ),
      },
    ],
    []
  );

  const fetchVolume = useCallback(
    async (silent = false) => {
      if (!nodeId || !decodedVolumeName) return;
      if (!silent) setIsLoading(true);
      try {
        let data = await api.inspectDockerVolume(nodeId, decodedVolumeName);
        if (!Array.isArray(data.usedBy) && data.usedByCount == null) {
          const volumes = await api.listDockerVolumes(nodeId, { search: decodedVolumeName });
          const listItem = volumes.find((item) => item.name === decodedVolumeName);
          if (listItem) {
            data = {
              ...data,
              usedBy: listItem.usedBy,
              usedByCount: listItem.usedByCount,
              usedByTruncated: listItem.usedByTruncated,
            };
          }
        }
        setVolume(data);
        const nextLabels = labelsToEntries(data.labels);
        setLabels(nextLabels);
        setSavedLabels(nextLabels);
      } catch (err) {
        toastApiError(err, "Failed to load volume");
      } finally {
        if (!silent) setIsLoading(false);
      }
    },
    [decodedVolumeName, nodeId]
  );

  useEffect(() => {
    void fetchVolume();
  }, [fetchVolume]);

  useEffect(() => {
    if (!composeProjectName || !nodeId) {
      setComposeOwnerProjectId(null);
      return;
    }
    let cancelled = false;
    api
      .listDockerComposeProjects(nodeId)
      .then(
        (projects) => projects.find((project) => project.name === composeProjectName)?.id ?? null
      )
      .then((projectId) => {
        if (!cancelled) setComposeOwnerProjectId(projectId);
      })
      .catch(() => {
        if (!cancelled) setComposeOwnerProjectId(null);
      })
      .finally(() => {
        if (!cancelled) setComposeOwnerLoadedFor(composeProjectName);
      });
    return () => {
      cancelled = true;
    };
  }, [composeProjectName, nodeId]);

  useEffect(() => {
    if (!nodeId || usedBy.length === 0) {
      setUsageContainers([]);
      return;
    }
    let cancelled = false;
    setUsageLoading(true);
    api
      .listDockerContainers(nodeId)
      .then((containers) => {
        if (cancelled) return;
        const matched = (containers ?? [])
          .filter((container: any) => usedBy.includes((container.name ?? "").replace(/^\//, "")))
          .map((container: any) => ({
            id: container.id ?? "",
            name: (container.name ?? "").replace(/^\//, ""),
            image: container.image ?? "",
            state: container.state ?? "",
            canOpen: true,
          }));
        setUsageContainers(
          matched.length > 0
            ? matched
            : usedBy.map((name) => ({
                id: name,
                name,
                image: "",
                state: "",
                canOpen: false,
              }))
        );
      })
      .catch(() => {
        if (!cancelled) {
          setUsageContainers(
            usedBy.map((name) => ({ id: name, name, image: "", state: "", canOpen: false }))
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setUsageLoading(false);
          setUsageLoadedFor(usedBy.join("\n"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, usedBy]);

  const fetchMetrics = useCallback(async () => {
    if (!nodeId || !decodedVolumeName || unavailable) return;
    const identity = `${nodeId}:${decodedVolumeName}`;
    if (metricsRequestRef.current === identity) return;
    metricsRequestRef.current = identity;
    try {
      const next = await api.getVolumeMetrics(nodeId, decodedVolumeName);
      if (metricsIdentityRef.current !== identity) return;
      setMetrics(next);
      if (lastMetricCollectedAtRef.current === next.collectedAt) return;
      lastMetricCollectedAtRef.current = next.collectedAt;
      setMetricHistory((previous) => ({
        space: [...previous.space, next.usedBytes ?? 0].slice(-60),
        inodes: [...previous.inodes, next.usedInodes ?? 0].slice(-60),
        attachments: [...previous.attachments, next.runningAttachmentCount].slice(-60),
      }));
    } catch {
      // Keep the last successful sample during transient daemon refreshes.
    } finally {
      if (metricsRequestRef.current === identity) metricsRequestRef.current = null;
      if (metricsIdentityRef.current === identity) setMetricsLoaded(true);
    }
  }, [decodedVolumeName, nodeId, unavailable]);

  useEffect(() => {
    setMetrics(null);
    lastMetricCollectedAtRef.current = null;
    setMetricHistory({ space: [], inodes: [], attachments: [] });
    void fetchMetrics();
  }, [fetchMetrics]);

  useEffect(() => {
    if (activeTab !== "settings") return;
    void fetchMetrics();
    const interval = window.setInterval(() => void fetchMetrics(), 30_000);
    return () => window.clearInterval(interval);
  }, [activeTab, fetchMetrics]);

  useRealtime("docker.volume.changed", (payload) => {
    const event = payload as { nodeId?: string; oldName?: string; name?: string };
    if (event.nodeId && event.nodeId !== nodeId) return;
    if (event.oldName === decodedVolumeName && event.name) {
      useUIStore
        .getState()
        .removeRecentPagesByPrefix(dockerVolumeRoute(nodeSlug, decodedVolumeName));
      navigate(dockerVolumeRoute(nodeSlug, event.name, activeTab), {
        replace: true,
        state: location.state,
      });
      return;
    }
    if (event.name && event.name !== decodedVolumeName) return;
    void fetchVolume(true);
  });

  useRealtime("docker.snapshot.changed", (payload) => {
    const event = payload as { nodeId?: string; kind?: string; key?: string };
    if (event.nodeId !== nodeId) return;
    if (event.key && event.key !== decodedVolumeName) return;
    if (event.kind === "volume-detail") void fetchVolume(true);
    if (event.kind === "volume-metrics") void fetchMetrics();
  });

  useEffect(() => {
    if (unavailable && activeTab === "files") setActiveTab("settings");
  }, [activeTab, setActiveTab, unavailable]);

  useRealtime("node.slug.changed", (payload) => {
    const event = payload as { id?: string; oldSlug?: string; slug?: string };
    if (event.id !== nodeId || event.oldSlug !== nodeSlug || !event.slug) return;
    navigate(dockerVolumeRoute(event.slug, decodedVolumeName, activeTab), {
      replace: true,
      state: location.state,
    });
  });

  const fetchDirectory = useCallback(
    (path: string) => {
      if (!nodeId || !decodedVolumeName) return Promise.resolve([]);
      return api.listVolumeDir(nodeId, decodedVolumeName, path);
    },
    [decodedVolumeName, nodeId]
  );
  const canMutateVolumeFiles = canWriteVolumeFiles && !unavailable;
  const fileOperations = useMemo<FileManagerOperations>(
    () => ({
      listDirectory: fetchDirectory,
      readFile: (path) => api.readVolumeFile(nodeId!, decodedVolumeName, path),
      openFile: (filePath, writable) => {
        const params = new URLSearchParams({ path: filePath });
        if (writable && canMutateVolumeFiles) params.set("writable", "1");
        const url = `/docker/volume-file/${nodeId}/${encodeURIComponent(decodedVolumeName)}?${params}`;
        const fileName = filePath.split("/").pop() || "file";
        window.open(
          url,
          `volume-file-${decodedVolumeName}-${fileName}`,
          "width=900,height=600,menubar=no,toolbar=no"
        );
      },
      ...(canMutateVolumeFiles
        ? {
            createFile: (path, content, onProgress) =>
              api.createVolumeFile(nodeId!, decodedVolumeName, path, content, onProgress),
            createDirectory: (path) => api.createVolumeDirectory(nodeId!, decodedVolumeName, path),
            deletePath: (path) => api.deleteVolumeFile(nodeId!, decodedVolumeName, path),
            movePath: (fromPath, toPath) =>
              api.moveVolumeFile(nodeId!, decodedVolumeName, fromPath, toPath),
            initUpload: (path, totalBytes) =>
              api.initVolumeFileUpload(nodeId!, decodedVolumeName, path, totalBytes),
            uploadChunk: (uploadId, offset, content, onProgress) =>
              api.uploadVolumeFileChunk(
                nodeId!,
                decodedVolumeName,
                uploadId,
                offset,
                content,
                onProgress
              ),
            completeUpload: (uploadId, path, totalBytes) =>
              api.completeVolumeFileUpload(nodeId!, decodedVolumeName, uploadId, path, totalBytes),
            abortUpload: (uploadId) =>
              api.abortVolumeFileUpload(nodeId!, decodedVolumeName, uploadId),
          }
        : {}),
    }),
    [canMutateVolumeFiles, decodedVolumeName, fetchDirectory, nodeId]
  );

  const handleExport = useCallback(async () => {
    if (!canExportVolume || !nodeId || !decodedVolumeName) return;
    setExporting(true);
    try {
      const blob = await api.exportDockerVolume(nodeId, decodedVolumeName);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${decodedVolumeName}.tar.gz`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Volume export started");
    } catch (err) {
      toastApiError(err, "Failed to export volume");
    } finally {
      setExporting(false);
    }
  }, [canExportVolume, decodedVolumeName, nodeId]);

  const openRename = useCallback(() => {
    setRenameValue(decodedVolumeName);
    setRenameOpen(true);
  }, [decodedVolumeName]);

  const handleRename = useCallback(async () => {
    if (actionLoading || !nodeId || !decodedVolumeName || !renameValue.trim()) return;
    const nextName = renameValue.trim();
    if (nextName === decodedVolumeName) {
      setRenameOpen(false);
      return;
    }
    setActionLoading(true);
    try {
      await api.renameVolume(nodeId, decodedVolumeName, nextName);
      toast.success("Volume renamed");
      setRenameOpen(false);
      const currentNodeSlug =
        useDockerStore.getState().dockerNodes.find((node) => node.id === nodeId)?.slug || nodeSlug;
      useUIStore
        .getState()
        .removeRecentPagesByPrefix(dockerVolumeRoute(currentNodeSlug, decodedVolumeName));
      navigate(dockerVolumeRoute(currentNodeSlug, nextName, activeTab), {
        replace: true,
        state: location.state,
      });
    } catch (err) {
      toastApiError(err, "Failed to rename volume");
    } finally {
      setActionLoading(false);
    }
  }, [
    actionLoading,
    activeTab,
    decodedVolumeName,
    location.state,
    navigate,
    nodeId,
    nodeSlug,
    renameValue,
  ]);

  const handleRemove = useCallback(async () => {
    if (!nodeId || !decodedVolumeName) return;
    const ok = await confirm({
      title: "Remove Volume",
      description: `Remove volume "${decodedVolumeName}"? Any data stored in this volume will be permanently lost.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    setActionLoading(true);
    setPendingAction("remove");
    try {
      await api.removeVolume(nodeId, decodedVolumeName);
      toast.success("Volume removed");
      navigate(backTarget);
    } catch (err) {
      toastApiError(err, "Failed to remove volume");
    } finally {
      setActionLoading(false);
      setPendingAction(null);
    }
  }, [backTarget, decodedVolumeName, navigate, nodeId]);

  const handleSaveLabels = useCallback(async () => {
    if (!nodeId || !decodedVolumeName || !labelsChanged || isUsed) return;
    setLabelsSaving(true);
    try {
      await api.updateVolumeLabels(nodeId, decodedVolumeName, labelsToRecord(labels));
      toast.success("Volume labels saved");
      const nextLabels = labelsToEntries(
        (await api.inspectDockerVolume(nodeId, decodedVolumeName)).labels
      );
      setLabels(nextLabels);
      setSavedLabels(nextLabels);
      void fetchVolume(true);
    } catch (err) {
      toastApiError(err, "Failed to save labels");
    } finally {
      setLabelsSaving(false);
    }
  }, [decodedVolumeName, fetchVolume, isUsed, labels, labelsChanged, nodeId]);

  const handleToggleCleanupProtection = useCallback(async () => {
    if (!nodeId || !decodedVolumeName || !isAnonymousVolume || isUsed) return;
    setActionLoading(true);
    setPendingAction("protect");
    try {
      const nextLabels = { ...(volume?.labels ?? {}) };
      if (isCleanupProtected) {
        delete nextLabels[VOLUME_CLEANUP_PROTECTED_LABEL];
      } else {
        nextLabels[VOLUME_CLEANUP_PROTECTED_LABEL] = "true";
      }
      await api.updateVolumeLabels(nodeId, decodedVolumeName, nextLabels);
      toast.success(
        isCleanupProtected ? "Volume cleanup protection removed" : "Volume protected from cleanup"
      );
      await fetchVolume(true);
    } catch (err) {
      toastApiError(err, "Failed to update cleanup protection");
    } finally {
      setActionLoading(false);
      setPendingAction(null);
    }
  }, [
    decodedVolumeName,
    fetchVolume,
    isAnonymousVolume,
    isCleanupProtected,
    isUsed,
    nodeId,
    volume?.labels,
  ]);

  const openResize = useCallback(() => {
    setResizeCapacityGb(String(currentCapacityGb + 1));
    setResizeOpen(true);
  }, [currentCapacityGb]);

  const handleResize = useCallback(async () => {
    if (!nodeId || !isDiskImage) return;
    const nextGb = Number(resizeCapacityGb);
    if (!Number.isInteger(nextGb) || nextGb <= currentCapacityGb) return;
    setResizing(true);
    try {
      await api.resizeVolume(nodeId, decodedVolumeName, nextGb * 1024 ** 3);
      toast.success("Volume storage resized");
      setResizeOpen(false);
      await Promise.all([fetchVolume(true), fetchMetrics()]);
    } catch (error) {
      toastApiError(error, "Failed to resize volume storage");
    } finally {
      setResizing(false);
    }
  }, [
    currentCapacityGb,
    decodedVolumeName,
    fetchMetrics,
    fetchVolume,
    isDiskImage,
    nodeId,
    resizeCapacityGb,
  ]);

  const composeOwnerPending =
    composeManaged && !!nodeId && composeOwnerLoadedFor !== composeProjectName;
  // The Settings tab opens with its metrics and the containers using the volume.
  const settingsTabLoading =
    isLoading ||
    (!unavailable && !metricsLoaded) ||
    (usedBy.length > 0 && usageLoadedFor !== usedBy.join("\n"));

  const headerActions = [
    ...(!composeManaged && canEditVolume && isDiskImage && volume?.managementState === "managed"
      ? [
          {
            label: "Resize",
            icon: <Scaling className="h-4 w-4" />,
            onClick: openResize,
            disabled: actionLoading || unavailable,
          },
        ]
      : []),
    ...(!composeManaged && canRenameVolume
      ? [
          {
            label: "Rename",
            icon: <Type className="h-4 w-4" />,
            onClick: openRename,
            disabled: actionLoading || isUsed || unavailable,
          },
        ]
      : []),
    ...(!composeManaged && canRenameVolume && isAnonymousVolume
      ? [
          {
            label: isCleanupProtected ? "Unprotect from cleanup" : "Protect from cleanup",
            icon: isCleanupProtected ? (
              <ShieldOff className="h-4 w-4" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            ),
            onClick: handleToggleCleanupProtection,
            disabled: actionLoading || isUsed || unavailable,
            separatorBefore: true,
          },
        ]
      : []),
    ...(!composeManaged && canDeleteVolume
      ? [
          {
            label: "Remove",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: handleRemove,
            disabled: actionLoading || isUsed || unavailable,
            destructive: true,
            separatorBefore: true,
          },
        ]
      : []),
  ];

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6">
        <div className="space-y-6">
          <ContentLoading loading={isLoading || composeOwnerPending} />
          <PageHeader
            leading={<PageBackButton onClick={() => navigate(backTarget)} />}
            title={decodedVolumeName}
            badges={
              unavailable ? (
                <Badge variant="secondary" size="inline">
                  Unavailable
                </Badge>
              ) : volume?.driver ? (
                <Badge variant="secondary" size="inline">
                  {volume.driver}
                </Badge>
              ) : null
            }
            description={
              <span className="block truncate">{volume?.mountpoint ?? "Docker volume"}</span>
            }
            actions={
              <ResponsiveHeaderActions actions={headerActions}>
                {!composeManaged &&
                  canEditVolume &&
                  isDiskImage &&
                  volume?.managementState === "managed" && (
                    <Button
                      variant="outline"
                      onClick={openResize}
                      disabled={actionLoading || unavailable}
                    >
                      <Scaling className="h-3.5 w-3.5" />
                      Resize
                    </Button>
                  )}
                {!composeManaged && canRenameVolume && (
                  <Button
                    variant="outline"
                    onClick={openRename}
                    disabled={actionLoading || isUsed || unavailable}
                  >
                    <Type className="h-3.5 w-3.5" />
                    Rename
                  </Button>
                )}
                {!composeManaged && canRenameVolume && isAnonymousVolume && (
                  <Button
                    variant="outline"
                    onClick={handleToggleCleanupProtection}
                    pending={pendingAction === "protect"}
                    disabled={isUsed || unavailable}
                  >
                    {pendingAction === "protect" ? null : isCleanupProtected ? (
                      <ShieldOff className="h-4 w-4" />
                    ) : (
                      <ShieldCheck className="h-4 w-4" />
                    )}
                    {isCleanupProtected ? "Unprotect from cleanup" : "Protect from cleanup"}
                  </Button>
                )}
                {!composeManaged && canDeleteVolume && (
                  <Button
                    variant="destructive"
                    onClick={handleRemove}
                    pending={pendingAction === "remove"}
                    disabled={actionLoading || isUsed || unavailable}
                  >
                    {pendingAction !== "remove" && <Trash2 className="h-4 w-4" />}
                    Remove
                  </Button>
                )}
              </ResponsiveHeaderActions>
            }
          />

          {composeManaged && (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-primary/20 bg-primary/5 p-3 text-sm">
              <div>
                <p className="font-medium">Managed by Compose project {composeProjectName}</p>
                <p className="text-muted-foreground">
                  Direct resize, rename, labels, and delete actions are disabled. Manage this volume
                  through Compose.
                </p>
              </div>
              {composeOwnerProjectId && (
                <Button
                  variant="outline"
                  onClick={() => navigate(dockerComposeProjectRoute(composeOwnerProjectId))}
                >
                  Open Compose project
                </Button>
              )}
            </div>
          )}

          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col min-h-0">
            <TabsList className="shrink-0">
              <TabsTrigger value="files" className="gap-1.5" disabled={!volume || unavailable}>
                Files
              </TabsTrigger>
              <TabsTrigger value="settings" className="gap-1.5">
                Settings
              </TabsTrigger>
            </TabsList>
            <TabsContent value="files" className="pb-0">
              {volume && !unavailable && (
                <FilesTab
                  nodeId={nodeId!}
                  canBrowse={canReadVolumeFiles}
                  operations={fileOperations}
                  description="Browse and manage files in this volume"
                  realtimeEvent="docker.volume.file.changed"
                  realtimeMatches={(payload) =>
                    payload.nodeId === nodeId && payload.volumeName === decodedVolumeName
                  }
                />
              )}
            </TabsContent>
            <TabsContent value="settings" className="pb-0">
              <div className="space-y-6">
                <ContentLoading loading={settingsTabLoading} />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <VolumeSpaceStatCard metrics={metrics} history={metricHistory.space} />
                  <StatCard
                    label="Inodes count"
                    value={
                      metrics?.usedInodes != null && metrics.totalInodes != null
                        ? `${metrics.usedInodes.toLocaleString()} / ${metrics.totalInodes.toLocaleString()}`
                        : "N/A"
                    }
                    icon={Hash}
                    history={metricHistory.inodes.length ? metricHistory.inodes : [0]}
                    color="var(--color-hue-violet)"
                    sparklineMax={metrics?.totalInodes ?? undefined}
                    subtitle={
                      isDiskImage
                        ? "Used / total filesystem inodes"
                        : "Unavailable for regular volumes"
                    }
                  />
                  <StatCard
                    label="Attached containers"
                    value={
                      metrics?.runningAttachmentCount == null
                        ? "N/A"
                        : String(metrics.runningAttachmentCount)
                    }
                    icon={Boxes}
                    history={metricHistory.attachments.length ? metricHistory.attachments : [0]}
                    color="var(--color-hue-green)"
                    subtitle="Running containers only"
                  />
                </div>
                <PanelShell
                  title="Usage"
                  description="Containers currently attached to this volume."
                >
                  <SimpleTable
                    columns={usageColumns}
                    rows={usageContainers}
                    getRowKey={(container) => container.id}
                    loading={usageLoading}
                    emptyMessage="No containers"
                    isRowClickable={(container) => container.canOpen}
                    onRowClick={(container) => {
                      navigate(dockerContainerRoute(nodeSlug, container.name), {
                        state: createReturnNavigationState(location),
                      });
                    }}
                  />
                </PanelShell>

                <LabelsSection
                  canEdit={canRenameVolume && !isUsed && !unavailable && !composeManaged}
                  labels={labels}
                  setLabels={setLabels}
                  labelsChanged={labelsChanged}
                  inputCell="h-9 rounded-none border-0 bg-transparent px-3 focus-visible:ring-0 focus-visible:ring-offset-0"
                  description={
                    isUsed
                      ? "Stop and detach containers using this volume before editing labels."
                      : "Saved by recreating the unused volume with the same contents."
                  }
                  action={
                    canRenameVolume ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleSaveLabels}
                        pending={labelsSaving}
                        disabled={!labelsChanged || isUsed || unavailable}
                        aria-label="Save labels"
                        title="Save labels"
                      >
                        <Save className="h-3.5 w-3.5" />
                      </Button>
                    ) : null
                  }
                />

                {canExportVolume ? (
                  <PanelShell
                    title="Export"
                    description="Download a tar.gz archive with the current volume contents."
                    headerBorder={false}
                    actions={
                      <Button onClick={handleExport} pending={exporting} disabled={unavailable}>
                        <Download className="h-3.5 w-3.5" />
                        Export
                      </Button>
                    }
                  />
                ) : null}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Volume</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            disabled={actionLoading || unavailable}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="New volume name"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              pending={actionLoading}
              disabled={unavailable || !renameValue.trim()}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={resizeOpen} onOpenChange={setResizeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Resize Volume</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Disk-image storage can only be increased. The filesystem is expanded without
              recreating the volume.
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="docker-volume-resize-capacity">
                New capacity, GB
              </label>
              <Input
                id="docker-volume-resize-capacity"
                type="number"
                min={currentCapacityGb + 1}
                step={1}
                value={resizeCapacityGb}
                onChange={(event) => setResizeCapacityGb(event.target.value)}
                disabled={resizing}
              />
              <p className="text-xs text-muted-foreground">
                Enter a whole number greater than {currentCapacityGb} GB.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResizeOpen(false)} disabled={resizing}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleResize()}
              pending={resizing}
              disabled={
                !Number.isInteger(Number(resizeCapacityGb)) ||
                Number(resizeCapacityGb) <= currentCapacityGb
              }
            >
              Resize volume
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
