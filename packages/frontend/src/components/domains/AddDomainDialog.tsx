import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import {
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { SwitchCard } from "@/components/common/SwitchCard";
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
import { toastApiError } from "@/lib/api-error-toast";
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

const NO_SCOPES: string[] = [];

const PREVIEW_ANIMATION = {
  initial: { height: 0, opacity: 0, y: 8 },
  animate: { height: "auto", opacity: 1, y: 0 },
  exit: { height: 0, opacity: 0, y: 8 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] },
} as const;

interface AddDomainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  dnsProvider: "cloudflare" | "external";
}

export function AddDomainDialog({
  open,
  onOpenChange,
  onCreated,
  dnsProvider,
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
  const canCreateInSelectedFolder = isCreateFolderAllowed(folderChoices, folderId);
  const eligibleNodes = nodeOptions?.eligibleNodes ?? [];
  const ingressGroups = nodeOptions?.ingressGroups ?? [];
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
    void fetchFolders("domain");
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
  }, [fetchFolders, open]);

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
      folderId: folderId || undefined,
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
          <AnimatePresence initial={false}>
            {(preview || previewError || isPreviewLoading) && (
              <motion.div {...PREVIEW_ANIMATION} className="overflow-hidden">
                <PanelShell
                  title={dnsProvider === "cloudflare" ? "Cloudflare DNS preview" : "DNS check"}
                  actions={
                    isPreviewLoading ? (
                      <LoaderCircle
                        className="h-4 w-4 animate-spin text-muted-foreground"
                        aria-label="Loading"
                      />
                    ) : preview && preview.status !== "ready" && preview.status !== "valid" ? (
                      <Badge
                        variant={
                          preview.status === "mismatch" ||
                          preview.status === "blocked" ||
                          preview.status === "invalid"
                            ? "warning"
                            : "secondary"
                        }
                        size="inline"
                      >
                        {preview.status}
                      </Badge>
                    ) : null
                  }
                  bodyClassName="divide-y divide-border"
                >
                  {preview?.dnsProvider === "cloudflare" ? (
                    <>
                      <DetailRow
                        label="Zone"
                        value={<span className="font-medium">{preview.zoneName}</span>}
                      />
                      <DetailRow
                        label="Target"
                        value={
                          <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
                            {preview.desiredRecords.map((record) => (
                              <Badge key={`${record.type}-${record.content}`} variant="outline">
                                {record.type} {record.content}
                              </Badge>
                            ))}
                          </div>
                        }
                      />
                      {preview.currentRecords.length > 0 && (
                        <DetailRow
                          label="Current"
                          value={
                            <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
                              {preview.currentRecords.map((record) => (
                                <Badge
                                  key={record.id ?? `${record.type}-${record.content}`}
                                  variant="outline"
                                >
                                  {record.type} {record.content}
                                </Badge>
                              ))}
                            </div>
                          }
                        />
                      )}
                    </>
                  ) : preview?.dnsProvider === "external" ? (
                    <>
                      <DetailRow
                        label="Expected"
                        value={
                          <span className="break-all font-mono text-xs">
                            {preview.targetIps.join(", ")}
                          </span>
                        }
                      />
                      <DetailRow
                        label="Resolved"
                        value={
                          <span className="break-all font-mono text-xs">
                            {[...preview.dnsRecords.a, ...preview.dnsRecords.aaaa].join(", ") ||
                              "No address records"}
                          </span>
                        }
                      />
                      {preview.queryName !== preview.domain && (
                        <DetailRow
                          label="Checked name"
                          value={
                            <span className="break-all font-mono text-xs">{preview.queryName}</span>
                          }
                        />
                      )}
                    </>
                  ) : (
                    <p className="px-4 py-3 text-sm text-muted-foreground">
                      {previewError ?? "Loading DNS preview..."}
                    </p>
                  )}
                </PanelShell>
              </motion.div>
            )}
          </AnimatePresence>
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
