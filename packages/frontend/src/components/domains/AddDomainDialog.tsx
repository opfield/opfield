import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppEnvironmentFields } from "@/components/apps/AppEnvironmentFields";
import {
  type AppCreateContext,
  allowedAppNodes,
  appPlacementFolderId,
  rememberAppCreation,
  useAppEnvironmentChoice,
} from "@/components/apps/app-create-context";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import {
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { SwitchCard } from "@/components/common/SwitchCard";
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
import { toastApiError } from "@/lib/api-error-toast";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type {
  DomainDnsConflictDetails,
  DomainNginxNodeOptions,
  DomainPreview,
} from "@/types/domains";
import { DomainIngressTargetField } from "./DomainIngressTargetField";
import { DomainPreviewPanel } from "./DomainPreviewPanel";

const NO_SCOPES: string[] = [];

interface AddDomainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  dnsProvider: "cloudflare" | "external";
  /** Opened from an app: locked App field, environment choice, its allowed nodes and placement folder. */
  appContext?: AppCreateContext;
}

export function AddDomainDialog({
  open,
  onOpenChange,
  onCreated,
  dnsProvider,
  appContext,
}: AddDomainDialogProps) {
  const [domain, setDomain] = useState("");
  const [description, setDescription] = useState("");
  const [folderId, setFolderId] = useState("");
  const [ttl, setTtl] = useState("1");
  const [proxied, setProxied] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [preview, setPreview] = useState<DomainPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [nodeOptions, setNodeOptions] = useState<DomainNginxNodeOptions | null>(null);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [nginxNodeId, setNginxNodeId] = useState("");
  // Served by every member of an ingress group instead of one node.
  const [ingressGroupId, setIngressGroupId] = useState("");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const domainFolders = useResourceFolderStore((state) => state.foldersByType.domain);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.domain);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const scopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  // Same destinations the backend accepts for domains:create: broad, node or folder grants.
  // The folder picker keeps the selection valid when the node or the grants change.
  const folderChoices = useMemo(
    () => getCreateFolderChoices(scopes, "domains:create", domainFolders ?? [], nginxNodeId),
    [domainFolders, nginxNodeId, scopes]
  );
  const { environment, environmentId, setEnvironmentId } = useAppEnvironmentChoice(
    appContext,
    open
  );
  // From an app the domain lands in the environment's placement folder, on its allowed nodes only.
  const placementFolderId = appContext ? appPlacementFolderId(environment, "domains") : null;
  const canCreateInSelectedFolder = appContext
    ? !!placementFolderId &&
      canCreateInFolder(scopes, "domains:create", placementFolderId, nginxNodeId || undefined)
    : isCreateFolderAllowed(folderChoices, folderId);
  const eligibleNodes = useMemo(() => {
    const nodes = nodeOptions?.eligibleNodes ?? [];
    return appContext ? allowedAppNodes(environment, nodes) : nodes;
  }, [appContext, environment, nodeOptions]);
  const ingressGroups = useMemo(() => {
    const groups = nodeOptions?.ingressGroups ?? [];
    if (!appContext) return groups;
    const allowed = new Set(environment?.allowedNodeIds ?? []);
    return groups.filter(
      (group) => group.members.length > 0 && group.members.every((member) => allowed.has(member.id))
    );
  }, [appContext, environment, nodeOptions]);
  const hasTarget = nginxNodeId !== "" || ingressGroupId !== "";
  const target = ingressGroupId ? { ingressGroupId } : { nginxNodeId };
  const chooseTarget = (next: { nginxNodeId: string; ingressGroupId: string }) => {
    setNginxNodeId(next.nginxNodeId);
    setIngressGroupId(next.ingressGroupId);
  };

  const resetForm = () => {
    setDomain("");
    setDescription("");
    setFolderId("");
    setTtl("1");
    setProxied(true);
    setPreview(null);
    setPreviewError(null);
    setIsPreviewLoading(false);
    setNodeOptions(null);
    setNodesError(null);
    setNodesLoading(false);
    setNginxNodeId("");
    setIngressGroupId("");
  };

  const scheduleReset = () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      resetForm();
      resetTimerRef.current = null;
    }, 320);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    } else {
      scheduleReset();
    }
    onOpenChange(nextOpen);
  };

  const ttlValue = useMemo(() => {
    const value = Number(ttl);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }, [ttl]);

  useEffect(() => {
    if (!open || !resetTimerRef.current) return;
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }, [open]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!appContext) void fetchFolders("domain");
    setNodesLoading(true);
    api
      .listDomainNginxNodes()
      .then((result) => {
        setNodeOptions(result);
        setNodesError(null);
        setNginxNodeId((current) => {
          if (result.eligibleNodes.some((node) => node.id === current)) return current;
          return result.eligibleNodes.length === 1 ? result.eligibleNodes[0]!.id : "";
        });
      })
      .catch((error) => {
        setNodeOptions(null);
        setNodesError(error instanceof Error ? error.message : "Unable to load Ingress nodes");
      })
      .finally(() => setNodesLoading(false));
  }, [appContext, fetchFolders, open]);

  // A node the chosen environment does not allow is not kept selected.
  useEffect(() => {
    if (!appContext || nodesLoading) return;
    setNginxNodeId((current) => {
      if (eligibleNodes.some((node) => node.id === current)) return current;
      return eligibleNodes.length === 1 ? eligibleNodes[0]!.id : "";
    });
    setIngressGroupId((current) =>
      current && !ingressGroups.some((group) => group.id === current) ? "" : current
    );
  }, [appContext, eligibleNodes, ingressGroups, nodesLoading]);

  useEffect(() => {
    if (!open) return;

    const normalizedDomain = domain.trim();
    if (
      normalizedDomain.length < 4 ||
      !normalizedDomain.includes(".") ||
      nodesLoading ||
      !hasTarget
    ) {
      setPreview(null);
      setPreviewError(null);
      setIsPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setIsPreviewLoading(true);
    const timer = window.setTimeout(() => {
      api
        .previewDomain({
          domain: normalizedDomain,
          dnsProvider,
          ...(dnsProvider === "cloudflare" ? { ttl: ttlValue, proxied } : {}),
          ...(ingressGroupId ? { ingressGroupId } : { nginxNodeId }),
        })
        .then((result) => {
          if (cancelled) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(err instanceof Error ? err.message : "Unable to preview DNS target");
        })
        .finally(() => {
          if (!cancelled) setIsPreviewLoading(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    dnsProvider,
    domain,
    hasTarget,
    ingressGroupId,
    nginxNodeId,
    nodesLoading,
    open,
    proxied,
    ttlValue,
  ]);

  const create = async (overwriteDns = false) => {
    return api.createDomain({
      domain: domain.trim(),
      dnsProvider,
      description: description.trim() || undefined,
      folderId: (appContext ? placementFolderId : folderId) || undefined,
      ...(dnsProvider === "cloudflare" ? { ttl: ttlValue, proxied, overwriteDns } : {}),
      ...target,
    });
  };

  const handleSubmit = async () => {
    if (!domain.trim()) {
      toast.error("Domain is required");
      return;
    }
    if (!hasTarget) {
      toast.error("Select an ingress node with a public address or an ingress group");
      return;
    }
    setIsSaving(true);
    try {
      await create();
      toast.success("Domain added");
      rememberAppCreation(appContext, environment);
      handleOpenChange(false);
      onCreated();
    } catch (err) {
      if (
        err instanceof ApiRequestError &&
        err.code === "DOMAIN_DNS_TARGET_MISMATCH" &&
        (err.details as DomainDnsConflictDetails | undefined)?.canOverwrite
      ) {
        const details = err.details as DomainDnsConflictDetails;
        const current = details.currentRecords
          ?.map((record) => `${record.type} ${record.content}`)
          .join(", ");
        const desired = details.desiredRecords
          ?.map((record) => `${record.type} ${record.content}`)
          .join(", ");
        const ok = await confirm({
          title: "Overwrite Cloudflare DNS",
          description: `Existing DNS target differs${details.zoneName ? ` in ${details.zoneName}` : ""}. Current: ${current || "unknown"}. Desired: ${desired || "unknown"}.`,
          confirmLabel: "Overwrite DNS",
          variant: "destructive",
        });
        if (ok) {
          try {
            await create(true);
            toast.success("Domain added");
            rememberAppCreation(appContext, environment);
            handleOpenChange(false);
            onCreated();
          } catch (retryError) {
            toastApiError(retryError, "Failed to add domain");
          }
        }
        setIsSaving(false);
        return;
      }
      setPreviewError(err instanceof Error ? err.message : "Failed to add domain");
      toastApiError(err, "Failed to add domain");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Domain</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {dnsProvider === "cloudflare"
            ? "Register a domain to track its DNS status and manage certificates."
            : "Check existing DNS against the selected Ingress node without changing DNS records."}
        </DialogDescription>
        <div className="space-y-4">
          {/* Nodes are the options of this form: open with them in place. */}
          <ContentLoading loading={nodeOptions === null && nodesError === null} />
          <div className="space-y-1.5">
            <label htmlFor="add-domain-name" className="text-sm font-medium">
              Domain
            </label>
            <Input
              id="add-domain-name"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              autoFocus
            />
          </div>
          {appContext ? (
            <AppEnvironmentFields
              context={appContext}
              environmentId={environmentId}
              onEnvironmentChange={setEnvironmentId}
              hint={`Opened from ${appContext.app.name}. The domain joins the environment.`}
            />
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="add-domain-folder" className="text-sm font-medium">
                Folder
              </label>
              <CreateFolderSelect
                id="add-domain-folder"
                choices={folderChoices}
                value={folderId}
                onChange={setFolderId}
                loading={foldersLoading}
              />
            </div>
          )}
          <DomainIngressTargetField
            nginxNodeId={nginxNodeId}
            ingressGroupId={ingressGroupId}
            onChange={chooseTarget}
            eligibleNodes={eligibleNodes}
            ingressGroups={ingressGroups}
            loading={nodesLoading}
            dnsProvider={dnsProvider}
          />
          <div className="space-y-1.5">
            <label htmlFor="add-domain-description" className="text-sm font-medium">
              Description
            </label>
            <Input
              id="add-domain-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional context for this domain"
            />
          </div>
          {dnsProvider === "cloudflare" && (
            <>
              <div className="space-y-1.5">
                <label htmlFor="add-domain-ttl" className="text-sm font-medium">
                  TTL
                </label>
                <Input
                  id="add-domain-ttl"
                  type="number"
                  min={1}
                  value={ttl}
                  onChange={(e) => setTtl(e.target.value)}
                  placeholder="1"
                />
                <p className="text-xs text-muted-foreground">
                  DNS record time to live in seconds; 1 lets Cloudflare choose.
                </p>
              </div>
              <SwitchCard
                label="Proxied"
                description="Serve the domain through the Cloudflare proxy."
                checked={proxied}
                onCheckedChange={setProxied}
              />
            </>
          )}
          <DomainPreviewPanel
            dnsProvider={dnsProvider}
            preview={preview}
            previewError={previewError}
            isPreviewLoading={isPreviewLoading}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            pending={isSaving}
            disabled={
              nodesLoading ||
              !hasTarget ||
              !canCreateInSelectedFolder ||
              !!nodesError ||
              (dnsProvider === "external" &&
                (isPreviewLoading ||
                  preview?.dnsProvider !== "external" ||
                  preview.status !== "valid"))
            }
          >
            {dnsProvider === "external" ? "Check DNS and Add" : "Add Domain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
