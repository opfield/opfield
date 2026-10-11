import { AnimatePresence, motion } from "framer-motion";
import { Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import {
  type GwcaImportMetadata,
  type GwcaPortMappingInput,
  gwcaPortKey,
  normalizeGwcaPortMappings,
  readGwcaImportMetadata,
} from "@/lib/gwca";
import { canCreateInFolder } from "@/lib/scope-utils";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerFolderStore } from "@/stores/docker-folders";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type {
  DockerFolderTreeNode,
  DockerNetwork,
  DockerVolume,
  Node as GatewayNode,
} from "@/types";

const BRIDGE_NETWORK: DockerNetwork = {
  id: "bridge",
  name: "bridge",
  driver: "bridge",
  scope: "local",
};

const DEV_PREVIEW_NODE_ID = "gwca-dev-preview-node";
const EMPTY_SCOPES: string[] = [];
const CREATE_NEW_VALUE = "__gwca_create_new__";
const REMAP_BLOCK_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};
const DEV_PREVIEW_METADATA: GwcaImportMetadata = {
  name: "payments-api-preview",
  networks: [
    { name: "frontend", driver: "bridge", createable: true },
    { name: "payments-overlay", driver: "overlay", createable: false, requiresMapping: true },
  ],
  mounts: [
    {
      type: "volume",
      source: "payments-database",
      target: "/var/lib/postgresql/data",
      readOnly: false,
      driver: "local",
      requiresMapping: true,
    },
    {
      type: "volume",
      source: "payments-cache",
      target: "/var/cache/payments",
      readOnly: false,
      driver: "local",
      createNew: true,
    },
  ],
  ports: [
    { containerPort: 443, hostPort: 8443, protocol: "tcp" },
    { containerPort: 5432, hostPort: 5432, protocol: "tcp" },
  ],
  secretKeys: ["DATABASE_PASSWORD", "PAYMENTS_API_TOKEN"],
  warnings: ["The writable layer was captured while the container was running."],
};
const DEV_PREVIEW_NETWORKS: DockerNetwork[] = [
  BRIDGE_NETWORK,
  { id: "frontend", name: "frontend", driver: "bridge", scope: "local" },
  { id: "overlay-target", name: "production-overlay", driver: "overlay", scope: "swarm" },
];
const DEV_PREVIEW_VOLUMES: DockerVolume[] = [
  {
    name: "payments-database-target",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/payments-database-target",
    scope: "local",
  },
];

interface GwcaImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: GatewayNode[];
  onImported: () => void | Promise<void>;
  devPreview?: boolean;
}

function hasNodeScope(hasScope: (scope: string) => boolean, scope: string, nodeId: string) {
  return hasScope(scope) || hasScope(`${scope}:${nodeId}`);
}

/** The imported container lands in the chosen folder, so a grant on that folder covers its secrets too. */
function hasDestinationScope(
  hasScope: (scope: string) => boolean,
  scope: string,
  nodeId: string,
  folderId: string
) {
  return (
    hasNodeScope(hasScope, scope, nodeId) || (!!folderId && hasScope(`${scope}:folder/${folderId}`))
  );
}

function flattenFolders(folders: DockerFolderTreeNode[]): DockerFolderTreeNode[] {
  return folders.flatMap((folder) => [folder, ...flattenFolders(folder.children)]);
}

export function GwcaImportDialog({
  open,
  onOpenChange,
  nodes,
  onImported,
  devPreview = false,
}: GwcaImportDialogProps) {
  const hasScope = useAuthStore((state) => state.hasScope);
  const scopes = useAuthStore((state) => state.user?.scopes ?? EMPTY_SCOPES);
  const dockerFolders = useDockerFolderStore((state) => state.foldersByType.container);
  const foldersLoading = useDockerFolderStore((state) => state.loadingByType.container);
  const fetchFolders = useDockerFolderStore((state) => state.fetchFolders);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [metadata, setMetadata] = useState<GwcaImportMetadata | null>(null);
  const [name, setName] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [targetNetworks, setTargetNetworks] = useState<DockerNetwork[]>([]);
  const [targetVolumes, setTargetVolumes] = useState<DockerVolume[]>([]);
  const [networkMappings, setNetworkMappings] = useState<Record<string, string>>({});
  const [volumeMappings, setVolumeMappings] = useState<Record<string, string>>({});
  const [portMappings, setPortMappings] = useState<Record<string, GwcaPortMappingInput>>({});
  const [planError, setPlanError] = useState("");
  const [planning, setPlanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const defaultNodeId = nodes[0]?.id ?? (devPreview ? DEV_PREVIEW_NODE_ID : "");
  // Same destination rule as the import route: root needs create on the node (or broadly), a folder needs create on
  // that folder. System folders never accept new containers.
  const canImportAtRoot =
    devPreview || canCreateInFolder(scopes, "docker:containers:create", null, nodeId || undefined);
  const folderOptions = useMemo(
    () =>
      flattenFolders(dockerFolders).filter(
        (folder) =>
          !folder.isSystem &&
          (devPreview ||
            canCreateInFolder(scopes, "docker:containers:create", folder.id, nodeId || undefined))
      ),
    [devPreview, dockerFolders, nodeId, scopes]
  );
  const canImportHere =
    devPreview ||
    canCreateInFolder(scopes, "docker:containers:create", folderId || null, nodeId || undefined);

  const resetImportState = useCallback(() => {
    setFile(null);
    setMetadata(null);
    setName("");
    setNodeId("");
    setFolderId("");
    setTargetNetworks([]);
    setTargetVolumes([]);
    setNetworkMappings({});
    setVolumeMappings({});
    setPortMappings({});
    setPlanError("");
    setPlanning(false);
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const canCreateNetworks =
    devPreview || (!!nodeId && hasNodeScope(hasScope, "docker:networks:create", nodeId));
  const canCreateVolumes =
    devPreview || (!!nodeId && hasNodeScope(hasScope, "docker:volumes:create", nodeId));
  const canImportSecrets =
    devPreview ||
    (!!nodeId && hasDestinationScope(hasScope, "docker:containers:secrets", nodeId, folderId));

  useEffect(() => {
    if (!open) return;
    void fetchFolders("container");
    resetImportState();
    setNodeId(defaultNodeId);
    if (devPreview) {
      setFile(
        new File(["Gateway container archive development preview"], "payments-api-full.gwca", {
          type: "application/vnd.wiolett.gwca",
        })
      );
      setMetadata(DEV_PREVIEW_METADATA);
      setName(DEV_PREVIEW_METADATA.name);
      setTargetNetworks(DEV_PREVIEW_NETWORKS);
      setTargetVolumes(DEV_PREVIEW_VOLUMES);
      setNetworkMappings({
        frontend: "frontend",
        "payments-overlay": "production-overlay",
      });
      setVolumeMappings({ "payments-database": "payments-database-target" });
      setPortMappings({
        [gwcaPortKey(DEV_PREVIEW_METADATA.ports[0])]: 9443,
        [gwcaPortKey(DEV_PREVIEW_METADATA.ports[1])]: 0,
      });
    }
  }, [defaultNodeId, devPreview, fetchFolders, open, resetImportState]);

  useEffect(() => {
    if (devPreview || !open) return;
    if (!file || !nodeId) {
      setMetadata(null);
      return;
    }
    let cancelled = false;
    setPlanning(true);
    setPlanError("");
    readGwcaImportMetadata(file)
      .then(async (archive) => ({
        archive,
        plan: await api.planContainerArchiveImport(nodeId, {
          networks: archive.networks,
          mounts: archive.mounts,
          ports: archive.ports,
        }),
      }))
      .then(({ archive, plan }) => {
        if (cancelled) return;
        const createNetworks = new Set(plan.resolution.createNetworks);
        const createVolumes = new Set(plan.resolution.createVolumes);
        const networkMap = Object.fromEntries(
          Object.entries(plan.resolution.networks).map(([source, target]) => [
            source,
            createNetworks.has(source) ? CREATE_NEW_VALUE : target,
          ])
        );
        const volumeMap = Object.fromEntries(
          archive.mounts
            .filter((entry) => entry.type === "volume" && entry.requiresMapping)
            .map((entry) => [
              entry.source,
              createVolumes.has(entry.source)
                ? CREATE_NEW_VALUE
                : (plan.resolution.volumes[entry.source] ?? ""),
            ])
        );
        setMetadata(archive);
        setName((current) => current || archive.name);
        setTargetNetworks(plan.networks);
        setTargetVolumes(plan.volumes);
        setNetworkMappings(networkMap);
        setVolumeMappings(volumeMap);
        setPortMappings(plan.resolution.ports);
        if (archive.secretKeys.length > 0 && !canImportSecrets) {
          setPlanError(
            "This archive contains secrets, but you cannot import secrets on the target node."
          );
        }
      })
      .catch((error) => {
        if (!cancelled)
          setPlanError(error instanceof Error ? error.message : "Failed to inspect archive");
      })
      .finally(() => {
        if (!cancelled) setPlanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canImportSecrets, devPreview, file, nodeId, open]);

  useEffect(() => {
    // A folder-only importer usually has exactly one valid destination: preselect it.
    if (open && !folderId && !canImportAtRoot && folderOptions.length === 1) {
      setFolderId(folderOptions[0].id);
    }
  }, [canImportAtRoot, folderId, folderOptions, open]);

  const unresolvedVolumes = useMemo(
    () => Object.values(volumeMappings).filter((value) => !value).length,
    [volumeMappings]
  );
  const resolvedPortMappings = useMemo(
    () => normalizeGwcaPortMappings(portMappings),
    [portMappings]
  );
  const externalVolumes =
    metadata?.mounts.filter((entry) => entry.type === "volume" && entry.requiresMapping) ?? [];
  const conflictingPorts =
    metadata?.ports.filter((entry) => Object.hasOwn(portMappings, gwcaPortKey(entry))) ?? [];

  const handleImport = async () => {
    if (
      !file ||
      !nodeId ||
      !name.trim() ||
      !canImportHere ||
      planning ||
      planError ||
      unresolvedVolumes > 0 ||
      !resolvedPortMappings
    )
      return;
    if (devPreview) {
      toast.info("GWCA import development preview", {
        description: "No container was created.",
      });
      return;
    }
    const submittedNodeId = nodeId;
    const submittedName = name.trim();
    setImporting(true);
    const toastId = toast.loading("Importing container archive...", {
      description: "Preparing upload",
      duration: Infinity,
      dismissible: false,
    });
    try {
      const createNetworks = Object.entries(networkMappings)
        .filter(([, target]) => target === CREATE_NEW_VALUE)
        .map(([source]) => source);
      const createVolumes = Object.entries(volumeMappings)
        .filter(([, target]) => target === CREATE_NEW_VALUE)
        .map(([source]) => source);
      const result = await api.importContainerArchive(
        submittedNodeId,
        submittedName,
        file,
        {
          networks: Object.fromEntries(
            Object.entries(networkMappings).map(([source, target]) => [
              source,
              target === CREATE_NEW_VALUE ? source : target,
            ])
          ),
          createNetworks,
          volumes: Object.fromEntries(
            Object.entries(volumeMappings).filter(([, target]) => target !== CREATE_NEW_VALUE)
          ),
          createVolumes,
          ports: resolvedPortMappings,
        },
        folderId || undefined,
        ({ loaded, total }) => {
          const description =
            total > 0
              ? `${Math.min(100, Math.round((loaded / total) * 100))}% (${formatBytes(loaded)} / ${formatBytes(total)})`
              : `${formatBytes(loaded)} uploaded`;
          toast.loading("Importing container archive...", {
            id: toastId,
            description,
            duration: Infinity,
            dismissible: false,
          });
        }
      );
      toast.success("Container archive imported", {
        id: toastId,
        description:
          result.containerName === submittedName
            ? "The container was created in stopped state."
            : `Imported as ${result.containerName} because the requested name was occupied.`,
        duration: 5000,
        dismissible: true,
      });
      onOpenChange(false);
      await onImported();
    } catch (error) {
      if (handleLicenseApiError(error, "Container archive import")) {
        toast.dismiss(toastId);
      } else {
        toast.error("Failed to import container archive", {
          id: toastId,
          description: error instanceof Error ? error.message : undefined,
          duration: 8000,
          dismissible: true,
        });
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && importing) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        hideCloseButton={importing}
        onEscapeKeyDown={(event) => {
          if (importing) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (importing) event.preventDefault();
        }}
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            resetImportState();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Import Container Archive</DialogTitle>
        </DialogHeader>
        <AnimatedHeight>
          <fieldset className="m-0 contents border-0 p-0" disabled={importing}>
            <div className="space-y-4">
              {/* The dialog opens once the destination folders are known. */}
              <ContentLoading loading={foldersLoading} />
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Archive</span>
                <input
                  ref={fileInputRef}
                  id="gwca-file"
                  type="file"
                  className="hidden"
                  accept=".gwca,application/vnd.wiolett.gwca"
                  onChange={(event) => {
                    const selected = event.target.files?.[0] ?? null;
                    setFile(selected);
                    setMetadata(null);
                    setName("");
                    setPlanError("");
                  }}
                />
                <div
                  className={cn(
                    "flex h-11 min-w-0 border bg-background",
                    planError ? "border-destructive" : "border-input"
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center px-3">
                    <div className="min-w-0">
                      <p className={cn("truncate text-sm", planError && "text-destructive")}>
                        {planning
                          ? "Inspecting archive…"
                          : planError || file?.name || "No archive selected"}
                        {!planning && !planError && file && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {devPreview ? "8.7 MB" : formatBytes(file.size)}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-full shrink-0 rounded-none border-0 border-l border-border"
                    disabled={importing}
                    onClick={() => {
                      if (!fileInputRef.current) return;
                      fileInputRef.current.value = "";
                      fileInputRef.current.click();
                    }}
                  >
                    <Upload className="h-4 w-4" />
                    {file ? "Replace" : "Choose"}
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Target node</label>
                <Select value={nodeId} onValueChange={setNodeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a Docker node" />
                  </SelectTrigger>
                  <SelectContent>
                    {devPreview && nodes.length === 0 && (
                      <SelectItem value={DEV_PREVIEW_NODE_ID}>Docker preview node</SelectItem>
                    )}
                    {nodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.displayName || node.hostname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Destination folder</label>
                <Select
                  value={folderId || (canImportAtRoot ? "__root__" : "")}
                  onValueChange={(value) => setFolderId(value === "__root__" ? "" : value)}
                >
                  <SelectTrigger aria-label="Destination folder">
                    <SelectValue placeholder="Select a folder" />
                  </SelectTrigger>
                  <SelectContent>
                    {canImportAtRoot && <SelectItem value="__root__">Root</SelectItem>}
                    {folderOptions.map((folder) => (
                      <SelectItem key={folder.id} value={folder.id}>
                        {`${"— ".repeat(folder.depth ?? 0)}${folder.name}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="gwca-name">
                  Container name
                </label>
                <Input
                  id="gwca-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  If this name is occupied, Gateway selects the next available suffix automatically.
                </p>
              </div>

              <AnimatePresence initial={false}>
                {metadata && metadata.networks.length > 0 && (
                  <motion.div key="network-remapping" {...REMAP_BLOCK_ANIMATION}>
                    <PanelShell
                      title="Network remapping"
                      description="Compatible networks are reused; portable missing networks are created automatically."
                    >
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-border bg-header text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <div className="px-3 py-2">Archive network</div>
                        <div className="border-l border-border px-3 py-2">Target</div>
                      </div>
                      {metadata.networks.map((source) => {
                        const mapped = networkMappings[source.name] ?? source.name;
                        const mappedExists =
                          mapped !== CREATE_NEW_VALUE &&
                          targetNetworks.some((network) => network.name === mapped);
                        return (
                          <div
                            key={source.name}
                            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-border last:border-b-0"
                          >
                            <div className="flex min-h-9 min-w-0 items-center px-3 py-2 text-sm">
                              <span className="truncate">{source.name}</span>
                            </div>
                            <Select
                              value={mapped}
                              onValueChange={(value) =>
                                setNetworkMappings((current) => ({
                                  ...current,
                                  [source.name]: value,
                                }))
                              }
                            >
                              <SelectTrigger className="h-9 rounded-none border-0 border-l border-border shadow-none focus:ring-1 focus:ring-inset">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {canCreateNetworks && (
                                  <SelectItem value={CREATE_NEW_VALUE}>Create new</SelectItem>
                                )}
                                {mapped !== CREATE_NEW_VALUE &&
                                  !mappedExists &&
                                  canCreateNetworks && (
                                    <SelectItem value={mapped}>Create {mapped}</SelectItem>
                                  )}
                                {targetNetworks.map((network) => (
                                  <SelectItem key={network.id || network.name} value={network.name}>
                                    {network.name} · {network.driver}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        );
                      })}
                    </PanelShell>
                  </motion.div>
                )}

                {externalVolumes.length > 0 && (
                  <motion.div key="volume-remapping" {...REMAP_BLOCK_ANIMATION}>
                    <PanelShell
                      title="Volume remapping"
                      description="Volumes that cannot be recreated directly must use a new or existing Gateway-managed local volume."
                    >
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-border bg-header text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <div className="px-3 py-2">Archive volume</div>
                        <div className="border-l border-border px-3 py-2">Target volume</div>
                      </div>
                      {externalVolumes.map((mount) => {
                        const compatible = targetVolumes.filter(
                          (volume) => !mount.driver || volume.driver === mount.driver
                        );
                        return (
                          <div
                            key={`${mount.source}:${mount.target}`}
                            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-border last:border-b-0"
                          >
                            <div className="flex min-h-9 min-w-0 items-center px-3 py-2 text-sm">
                              <span className="truncate">{mount.source}</span>
                            </div>
                            <Select
                              value={volumeMappings[mount.source] || undefined}
                              onValueChange={(value) =>
                                setVolumeMappings((current) => ({
                                  ...current,
                                  [mount.source]: value,
                                }))
                              }
                            >
                              <SelectTrigger className="h-9 rounded-none border-0 border-l border-border shadow-none focus:ring-1 focus:ring-inset">
                                <SelectValue placeholder="Select target volume" />
                              </SelectTrigger>
                              <SelectContent>
                                {canCreateVolumes && (
                                  <SelectItem value={CREATE_NEW_VALUE}>Create new</SelectItem>
                                )}
                                {compatible.map((volume) => (
                                  <SelectItem key={volume.name} value={volume.name}>
                                    {volume.name} · {volume.driver}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        );
                      })}
                    </PanelShell>
                  </motion.div>
                )}

                {conflictingPorts.length > 0 && (
                  <motion.div key="port-remapping" {...REMAP_BLOCK_ANIMATION}>
                    <PanelShell
                      title="Port remapping"
                      description="These host ports are occupied. Use 0 to let Docker assign a free port."
                    >
                      <div className="grid grid-cols-[minmax(0,1fr)_140px] border-b border-border bg-header text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <div className="px-3 py-2">Archive binding</div>
                        <div className="border-l border-border px-3 py-2">Target port</div>
                      </div>
                      {conflictingPorts.map((port) => {
                        const key = gwcaPortKey(port);
                        return (
                          <div
                            key={key}
                            className="grid grid-cols-[minmax(0,1fr)_140px] border-b border-border last:border-b-0"
                          >
                            <div className="flex min-h-9 items-center px-3 py-2 text-sm">
                              <span className="truncate">
                                {port.hostPort} → {port.containerPort}/{port.protocol}
                              </span>
                            </div>
                            <Input
                              type="number"
                              min={0}
                              max={65535}
                              step={1}
                              value={portMappings[key] ?? ""}
                              onChange={(event) => {
                                const value = event.target.value;
                                setPortMappings((current) => ({
                                  ...current,
                                  [key]: value === "" ? "" : Number(value),
                                }));
                              }}
                              className="h-9 rounded-none border-0 border-l border-border shadow-none"
                            />
                          </div>
                        );
                      })}
                    </PanelShell>
                  </motion.div>
                )}

                {metadata?.secretKeys.length ? (
                  <motion.p
                    key="secret-summary"
                    {...REMAP_BLOCK_ANIMATION}
                    className="text-xs text-muted-foreground"
                  >
                    This archive contains {metadata.secretKeys.length} secret value
                    {metadata.secretKeys.length === 1 ? "" : "s"}. They will be encrypted with the
                    target Gateway key after import.
                  </motion.p>
                ) : null}
              </AnimatePresence>
              <p className="text-xs text-muted-foreground">
                The image and supported Gateway configuration will be restored. Local volumes are
                recreated empty, endpoint addresses are reassigned, and the container remains
                stopped.
              </p>
            </div>
          </fieldset>
        </AnimatedHeight>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleImport()}
            pending={importing}
            disabled={
              planning ||
              !!planError ||
              unresolvedVolumes > 0 ||
              !resolvedPortMappings ||
              !file ||
              !nodeId ||
              !name.trim() ||
              !canImportHere
            }
          >
            Import container
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
