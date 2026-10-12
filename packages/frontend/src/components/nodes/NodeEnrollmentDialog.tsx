import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { ContentLoading } from "@/components/common/ContentLoading";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import { OneTimeSecretDialog } from "@/components/common/OneTimeSecretDialog";
import { HostAccessInstallOptions } from "@/components/nodes/HostAccessInstallOptions";
import { HostingNodeWizard } from "@/components/nodes/HostingNodeWizard";
import { UnreleasedInstallerNote } from "@/components/nodes/UnreleasedInstallerNote";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { allowedCreationFolderId, creationFolderChoices } from "@/lib/creation-folders";
import { nodeChangesFor } from "@/lib/node-changed";
import {
  DEFAULT_HOST_ACCESS_INSTALL_OPTIONS,
  withHostAccessInstallFlags,
} from "@/lib/node-host-access";
import { canCreateInFolder } from "@/lib/scope-utils";
import { STEP_ANIMATION } from "@/pages/notifications/template-editor";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { Node, NodeInstallation, NodeType, ResourceFolderTreeNode } from "@/types";
import type { HostingOperation, HostingResource } from "@/types/hosting";

export const NODE_ENROLLMENT_TYPES: Array<{
  value: NodeType;
  label: string;
  description: string;
}> = [
  {
    value: "nginx",
    label: "Ingress",
    description: "Terminates TLS and serves public domains and routes.",
  },
  {
    value: "docker",
    label: "Docker",
    description: "Runs and manages containers, Compose projects, images, networks, and volumes.",
  },
  {
    value: "builder",
    label: "Build Worker",
    description: "Builds Git revisions and scans artifacts on an isolated Docker worker.",
  },
  {
    value: "storage",
    label: "Storage",
    description: "Hosts managed databases, private S3 object storage, and database backup runners.",
  },
  {
    value: "monitoring",
    label: "Monitoring",
    description: "Collects host health and metrics without managing workloads.",
  },
  {
    value: "relay",
    label: "Relay",
    description: "Adds a physical host to the Secure Link Relay Pool.",
  },
];

/** The port the relay installer binds unless it is given another one. */
const DEFAULT_RELAY_PORT = 9443;

/** A relay port typed into the form, or null while it is not a TCP port. */
function parseRelayPort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

function canonicalEnrollmentType(type: NodeType): NodeType {
  return type === "databases" ? "storage" : type;
}

type EnrollmentResult = NodeInstallation & {
  nodeId: string;
  displayName: string;
  type: NodeType;
  token: string;
  reissued?: boolean;
};

type HostingRequest = {
  connectorId?: string;
  existingResource?: HostingResource;
};

export function NodeEnrollmentDialog({
  open,
  onOpenChange,
  initialType = "nginx",
  lockType = false,
  initialMode = "external",
  lockMode = false,
  hosting,
  onNodeCreated,
  onNodeEnrolled,
  onHostingCreated,
  reissueNode,
  onReissueHandled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialType?: NodeType;
  lockType?: boolean;
  initialMode?: "external" | "hosting";
  lockMode?: boolean;
  hosting?: HostingRequest;
  onNodeCreated?: (node: Node) => void;
  onNodeEnrolled?: (nodeId: string) => void;
  onHostingCreated?: (operation: HostingOperation) => void;
  /** A pending node to issue a fresh enrollment token for; shows its setup command. */
  reissueNode?: Node | null;
  onReissueHandled?: () => void;
}) {
  const user = useAuthStore((state) => state.user);
  const [mode, setMode] = useState<"external" | "hosting">(initialMode);
  const [type, setType] = useState<NodeType>(() => canonicalEnrollmentType(initialType));
  const [displayName, setDisplayName] = useState("");
  const [folderId, setFolderId] = useState("");
  const [relayAddress, setRelayAddress] = useState("");
  const [relayPort, setRelayPort] = useState(String(DEFAULT_RELAY_PORT));
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (open) setCreating(false);
  }, [open]);
  const {
    open: resultOpen,
    value: result,
    setValue: setResult,
    close: closeResult,
    onOpenChange: onResultOpenChange,
  } = useDeferredDialogState<EnrollmentResult>();
  const [targetId, setTargetId] = useState("public");
  const [transport, setTransport] = useState<"curl" | "wget">("curl");
  const [hostAccess, setHostAccess] = useState(DEFAULT_HOST_ACCESS_INSTALL_OPTIONS);
  const completedNodeRef = useRef<string | null>(null);
  const retainedHosting = useRetainedDialogValue(hosting ?? null, open);
  const [hostingModeLocked, setHostingModeLocked] = useState(false);
  const nodeFolders = useResourceFolderStore((state) => state.foldersByType.node);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.node);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const folderOptions = useMemo(() => flattenFolders(nodeFolders), [nodeFolders]);
  const fixedHosting = Boolean(retainedHosting?.connectorId || retainedHosting?.existingResource);
  const effectiveMode = fixedHosting ? "hosting" : mode;

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setType(canonicalEnrollmentType(initialType));
    setDisplayName("");
    setFolderId("");
    setRelayAddress("");
    setRelayPort(String(DEFAULT_RELAY_PORT));
    void fetchFolders("node");
  }, [fetchFolders, initialMode, initialType, open]);

  // Same destination rule as POST /nodes. A folder-only creator is never offered the root: preselect
  // their only folder instead of leaving the picker empty.
  const creationChoices = useMemo(
    () => creationFolderChoices(user?.scopes ?? [], "nodes:create", folderOptions),
    [folderOptions, user?.scopes]
  );
  useEffect(() => {
    if (!open) return;
    const next = allowedCreationFolderId(creationChoices, folderId);
    if (next !== folderId) setFolderId(next);
  }, [creationChoices, folderId, open]);

  const present = useDialogPresence(open);
  // Reset once the close animation has played, so the closing dialog keeps its content.
  useEffect(() => {
    if (!present) setHostingModeLocked(false);
  }, [present]);

  useEffect(() => {
    if (!result) completedNodeRef.current = null;
  }, [result]);

  const completeEnrollment = useCallback(
    (nodeId: string) => {
      if (!resultOpen || result?.nodeId !== nodeId || completedNodeRef.current === nodeId) return;
      completedNodeRef.current = nodeId;
      toast.success(`${result.displayName} enrolled`);
      closeResult();
      onNodeEnrolled?.(nodeId);
    },
    [closeResult, onNodeEnrolled, result, resultOpen]
  );

  const checkEnrollment = useCallback(async () => {
    if (!resultOpen || !result) return;
    try {
      const node = await api.getNode(result.nodeId);
      if (node.status === "online") completeEnrollment(node.id);
    } catch {
      // The realtime event or the next reconnect will retry the status check.
    }
  }, [completeEnrollment, result, resultOpen]);

  useEffect(() => {
    void checkEnrollment();
  }, [checkEnrollment]);

  useRealtime(
    resultOpen && result ? "node.changed" : null,
    (payload) => {
      const nodeId = result?.nodeId;
      if (!nodeId) return;
      const changes = nodeChangesFor(payload, nodeId);
      if (changes.length === 0) return;
      if (changes.some((change) => change.status === "online")) completeEnrollment(nodeId);
      else void checkEnrollment();
    },
    { onReconnect: () => void checkEnrollment() }
  );

  const selectedType =
    NODE_ENROLLMENT_TYPES.find((candidate) => candidate.value === type) ??
    NODE_ENROLLMENT_TYPES[0]!;
  const relayServicePort = parseRelayPort(relayPort);
  const canCreate =
    canCreateInFolder(user?.scopes ?? [], "nodes:create", folderId || null) &&
    displayName.trim().length > 0 &&
    (type !== "relay" || (relayAddress.trim().length > 0 && relayServicePort !== null));
  const modeLocked = creating || hostingModeLocked;

  const createNode = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const normalizedRelayAddress = relayAddress.trim();
      const response = await api.createNode({
        type,
        hostname: "pending",
        displayName: displayName.trim(),
        folderId: folderId || null,
        ...(type === "relay"
          ? {
              serviceAddresses: [normalizedRelayAddress],
              servicePort: relayServicePort ?? DEFAULT_RELAY_PORT,
            }
          : {}),
      });
      setResult({
        nodeId: response.node.id,
        displayName: displayName.trim(),
        type,
        token: response.enrollmentToken,
        installerRelease: response.installerRelease,
        installCommands: response.installCommands,
      });
      completedNodeRef.current = null;
      setTargetId("public");
      setTransport("curl");
      setHostAccess(DEFAULT_HOST_ACCESS_INSTALL_OPTIONS);
      onNodeCreated?.(response.node);
      onOpenChange(false);
    } catch (error) {
      if (!handleLicenseApiError(error, "Managed nodes")) {
        toastApiError(error, "Failed to create node");
      }
      setCreating(false);
    }
  };

  const onReissueHandledRef = useRef(onReissueHandled);
  onReissueHandledRef.current = onReissueHandled;
  useEffect(() => {
    if (!reissueNode) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.regenerateNodeEnrollmentToken(reissueNode.id);
        if (cancelled) return;
        setResult({
          nodeId: reissueNode.id,
          displayName: reissueNode.displayName || reissueNode.hostname,
          type: reissueNode.type,
          token: response.enrollmentToken,
          installerRelease: response.installerRelease,
          installCommands: response.installCommands,
          reissued: true,
        });
        completedNodeRef.current = null;
        setTargetId("public");
        setTransport("curl");
        setHostAccess(DEFAULT_HOST_ACCESS_INSTALL_OPTIONS);
      } catch (error) {
        if (!cancelled) {
          toastApiError(error, "Failed to generate a new token");
        }
      } finally {
        if (!cancelled) onReissueHandledRef.current?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reissueNode, setResult]);

  const targets = result?.installCommands ?? [];
  const selectedTarget = targets.find((target) => target.target === targetId) ?? targets[0];
  const command = withHostAccessInstallFlags(
    selectedTarget?.[transport] ?? "",
    result?.type === "relay" ? hostAccess : { ...hostAccess, protectedMode: false }
  );

  const setupDescription =
    result?.type === "relay"
      ? "Installs the Relay supervisor and enrolls this host into the Relay Pool."
      : result?.type === "docker"
        ? "Installs the Docker management daemon and enrolls with this Opfield installation."
        : result?.type === "builder"
          ? "Installs the isolated Docker builder profile and enrolls with this Opfield installation."
          : result?.type === "databases"
            ? "Verifies safe ext4 image storage, then installs the managed database daemon."
            : result?.type === "storage"
              ? "Verifies safe ext4 image storage, then installs the managed Storage daemon."
              : result?.type === "monitoring"
                ? "Installs the monitoring agent and enrolls with this Opfield installation."
                : "Installs Nginx and the ingress daemon, then enrolls with this Opfield installation.";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <HostingNodeWizard
          open={open && effectiveMode === "hosting"}
          onClose={() => onOpenChange(false)}
          connectorId={retainedHosting?.connectorId}
          existingResource={retainedHosting?.existingResource}
          onCreated={onHostingCreated}
          onModeLockChange={setHostingModeLocked}
          render={({ body, footer }) => (
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Add Node</DialogTitle>
                <DialogDescription>
                  {effectiveMode === "external"
                    ? "Create a pending node and run its one-time setup command on the target host."
                    : retainedHosting?.existingResource
                      ? "Install Opfield on the selected provider VM."
                      : "Create and enroll a node using a connected hosting account. Nothing is ordered before your confirmation."}
                </DialogDescription>
              </DialogHeader>
              {!fixedHosting && !lockMode && (
                <Tabs value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
                  <TabsList>
                    <TabsTrigger value="external" disabled={modeLocked}>
                      External
                    </TabsTrigger>
                    <TabsTrigger value="hosting" disabled={modeLocked}>
                      Hosting
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
              <AnimatedHeight>
                <AnimatePresence initial={false} mode="wait">
                  <motion.div key={effectiveMode} {...STEP_ANIMATION}>
                    {effectiveMode === "external" ? (
                      <div className="space-y-4">
                        {/* The folder list loads when the dialog opens. */}
                        <ContentLoading loading={foldersLoading} />
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Node Type</label>
                          <Select
                            value={type}
                            onValueChange={(value) => setType(value as NodeType)}
                            disabled={lockType}
                          >
                            <SelectTrigger aria-label="Node Type">
                              <SelectValue>{selectedType.label}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="w-[min(28rem,calc(100vw-2rem))]">
                              {NODE_ENROLLMENT_TYPES.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                  textValue={option.label}
                                  description={option.description}
                                  className="items-start py-2"
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            {selectedType.description}
                          </p>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Folder</label>
                          <Select
                            value={
                              folderId ||
                              (canCreateInFolder(user?.scopes ?? [], "nodes:create", null)
                                ? "__none__"
                                : "")
                            }
                            onValueChange={(value) =>
                              setFolderId(value === "__none__" ? "" : value)
                            }
                            disabled={foldersLoading}
                          >
                            <SelectTrigger aria-label="Folder" aria-busy={foldersLoading}>
                              <SelectValue placeholder="Select a folder" />
                            </SelectTrigger>
                            <SelectContent>
                              {canCreateInFolder(user?.scopes ?? [], "nodes:create", null) && (
                                <SelectItem value="__none__">No folder</SelectItem>
                              )}
                              {folderOptions
                                .filter((folder) =>
                                  canCreateInFolder(user?.scopes ?? [], "nodes:create", folder.id)
                                )
                                .map((folder) => (
                                  <SelectItem key={folder.id} value={folder.id}>
                                    {"  ".repeat(folder.depth) + folder.name}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Node Name</label>
                          <Input
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                            placeholder={type === "relay" ? "EU Relay" : "US-East Ingress"}
                          />
                        </div>
                        {type === "relay" && (
                          <div className="space-y-1.5">
                            <label className="text-sm font-medium">Relay Address</label>
                            <Input
                              value={relayAddress}
                              onChange={(event) => setRelayAddress(event.target.value)}
                              placeholder="relay.example.com"
                            />
                            <p className="text-xs text-muted-foreground">
                              Reachable IP or hostname advertised to participating nodes.
                            </p>
                          </div>
                        )}
                        {type === "relay" && (
                          <div className="space-y-1.5">
                            <label className="text-sm font-medium">Relay Port</label>
                            <Input
                              value={relayPort}
                              onChange={(event) => setRelayPort(event.target.value)}
                              inputMode="numeric"
                              placeholder={String(DEFAULT_RELAY_PORT)}
                            />
                            <p className="text-xs text-muted-foreground">
                              TCP port the relay listens on. It must be reachable from participating
                              nodes.
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      body
                    )}
                  </motion.div>
                </AnimatePresence>
              </AnimatedHeight>
              <DialogFooter>
                {effectiveMode === "external" ? (
                  <>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={() => void createNode()}
                      pending={creating}
                      disabled={!canCreate}
                    >
                      Create Node
                    </Button>
                  </>
                ) : (
                  footer
                )}
              </DialogFooter>
            </DialogContent>
          )}
        />
      </Dialog>

      <OneTimeSecretDialog
        open={resultOpen}
        onOpenChange={onResultOpenChange}
        className="sm:max-w-2xl"
        title={result?.reissued ? "New Enrollment Token" : "Node Created"}
        description={
          <>
            {result?.reissued ? "Any earlier token for this node no longer works. " : ""}
            Run the setup command on the host; this dialog closes when the node completes
            enrollment. The enrollment token is single-use and expires after 7 days.
          </>
        }
        fields={
          result
            ? [
                {
                  label: "Enrollment token",
                  value: result.token,
                  hint: "For manual setup and troubleshooting only.",
                },
              ]
            : null
        }
      >
        {result && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Setup Command</label>
            <p className="text-xs text-muted-foreground">{setupDescription}</p>
            <UnreleasedInstallerNote installerRelease={result.installerRelease} />
            {targets.length > 1 && (
              <p className="text-xs text-muted-foreground">
                Use the public command for remote hosts and the local command for nodes on the
                private network.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {targets.length > 1 && (
                <Tabs value={selectedTarget?.target ?? "public"} onValueChange={setTargetId}>
                  <TabsList>
                    {targets.map((target) => (
                      <TabsTrigger key={target.target} value={target.target}>
                        {target.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
              <Tabs
                value={transport}
                onValueChange={(value) => setTransport(value as "curl" | "wget")}
              >
                <TabsList>
                  <TabsTrigger value="curl">curl</TabsTrigger>
                  <TabsTrigger value="wget">wget</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <HostAccessInstallOptions
              value={hostAccess}
              onChange={setHostAccess}
              relay={result?.type === "relay"}
            />
            {selectedTarget && (
              <CopyCodeBlock
                label={`${transport} command`}
                value={command}
                copyValue={command.replace(/\s*\\\n\s*/g, " ")}
                className="[&>p]:hidden"
              />
            )}
          </div>
        )}
      </OneTimeSecretDialog>
    </>
  );
}

function flattenFolders(folders: ResourceFolderTreeNode[]): ResourceFolderTreeNode[] {
  return folders.flatMap((folder) => [folder, ...flattenFolders(folder.children)]);
}
