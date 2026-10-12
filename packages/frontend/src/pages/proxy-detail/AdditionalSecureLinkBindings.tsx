import { Link2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Combobox } from "@/components/common/Combobox";
import { confirmAction } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import {
  DEFAULT_PROXY_UPSTREAM,
  isProxyUpstreamValid,
  ProxyUpstreamFields,
  type ProxyUpstreamSelection,
} from "@/components/proxy/ProxyUpstreamEditor";
import { Badge } from "@/components/ui/badge";
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
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { usePlanIncludes } from "@/stores/license-paywall";
import type { DockerContainer, ManagedObjectStorage, ProxyAdditionalSecureLink } from "@/types";

const EMPTY_SELECTION: ProxyUpstreamSelection = {
  ...DEFAULT_PROXY_UPSTREAM,
  kind: "docker_container",
};

export function AdditionalSecureLinkBindings({
  hostId,
  canManage,
  removeDisabledReason = null,
}: {
  hostId: string;
  canManage: boolean;
  /** Why removing a binding is disabled (the route's app environment is isolated by the kill switch). */
  removeDisabledReason?: string | null;
}) {
  const [bindings, setBindings] = useState<ProxyAdditionalSecureLink[] | null>(null);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [selection, setSelection] = useState<ProxyUpstreamSelection>(EMPTY_SELECTION);
  const [storageTarget, setStorageTarget] = useState(false);
  const [managedStorageId, setManagedStorageId] = useState("");
  const [storages, setStorages] = useState<ManagedObjectStorage[]>([]);
  const [storagesLoading, setStoragesLoading] = useState(false);
  const [storagesError, setStoragesError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fieldId = useId();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const hiddenBindingIds = useRef(new Set<string>());
  const requestGeneration = useRef(0);
  useContentLoading(bindings === null);
  const managedStorageIncluded = usePlanIncludes("managed-storage");

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    const [nextBindings, nextContainers] = await Promise.all([
      api.listProxyAdditionalSecureLinks(hostId),
      api.listDockerContainerSnapshots(),
    ]);
    if (generation !== requestGeneration.current) return;
    setBindings(
      nextBindings.filter(
        (binding) =>
          binding.status !== "cleanup_pending" && !hiddenBindingIds.current.has(binding.id)
      )
    );
    setContainers(nextContainers);
  }, [hostId]);

  useEffect(() => {
    void load().catch((error) => {
      setBindings([]);
      toastApiError(error, "Failed to load additional Secure Links");
    });
    return () => {
      requestGeneration.current++;
    };
  }, [load]);
  useRealtime("proxy.secure-link.changed", load);
  useRealtime(
    "proxy.additional-route.changed",
    (payload) => {
      const event = payload as { hostId?: string; id?: string };
      if ((event.hostId ?? event.id) === hostId) return load();
    },
    { onReconnect: load }
  );
  useRealtime("docker.snapshot.changed", load);
  useRealtime("docker.deployment.changed", load);

  useEffect(() => {
    if (!adding || !storageTarget || !managedStorageIncluded) return;
    let cancelled = false;
    setStoragesLoading(true);
    setStoragesError(null);
    setStorages([]);
    void api
      .listManagedObjectStorages()
      .then((rows) => {
        if (!cancelled) setStorages(rows.filter((storage) => storage.status === "ready"));
      })
      .catch((error) => {
        if (!cancelled)
          setStoragesError(error instanceof Error ? error.message : "Failed to load storages");
      })
      .finally(() => {
        if (!cancelled) setStoragesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adding, storageTarget, managedStorageIncluded]);

  const validName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name);
  const nameInvalid = name.length > 0 && !validName;
  const canProvision =
    validName &&
    (storageTarget
      ? !storagesLoading && storages.some((storage) => storage.id === managedStorageId)
      : (selection.kind === "docker_container" || selection.kind === "docker_deployment") &&
        isProxyUpstreamValid(selection));
  const variableFor = (binding: ProxyAdditionalSecureLink) =>
    `{{additionalSecureLinks.${binding.name}}}`;
  const actionColumnCount = bindings?.some(
    (binding) => binding.purpose === "user_managed" && binding.status === "failed"
  )
    ? 2
    : bindings?.some((binding) => binding.purpose === "user_managed" && binding.status === "active")
      ? 1
      : 0;
  const bindingGridTemplate = `minmax(0,9rem) minmax(0,11rem) minmax(0,5rem) minmax(0,5rem) minmax(18rem,1fr) minmax(0,7rem)${
    actionColumnCount > 0 ? ` repeat(${actionColumnCount}, 2.25rem)` : ""
  }`;

  const resetDraft = () => setAdding(false);

  const addingPresent = useDialogPresence(adding);
  useEffect(() => {
    if (addingPresent) return;
    setName("");
    setSelection(EMPTY_SELECTION);
    setStorageTarget(false);
    setManagedStorageId("");
  }, [addingPresent]);

  const provision = async () => {
    if (
      !canProvision ||
      (!storageTarget &&
        selection.kind !== "docker_container" &&
        selection.kind !== "docker_deployment")
    )
      return;
    setPending(true);
    try {
      const binding = await api.createProxyAdditionalSecureLink(
        hostId,
        storageTarget
          ? {
              name,
              upstreamKind: "managed_storage",
              managedStorageId,
              forwardScheme: "http",
            }
          : {
              name,
              upstreamKind: selection.kind as "docker_container" | "docker_deployment",
              forwardScheme: selection.scheme,
              dockerNodeId: selection.dockerNodeId,
              dockerContainerName: selection.containerName,
              dockerComposeProjectId: selection.composeProjectId,
              dockerComposeServiceName: selection.composeServiceName,
              dockerDeploymentId: selection.deploymentId,
              dockerContainerPort: selection.containerPort!,
            }
      );
      setBindings((current) => {
        const existing = current?.findIndex((item) => item.id === binding.id) ?? -1;
        if (existing < 0) return [...(current ?? []), binding];
        const next = [...(current ?? [])];
        next[existing] = binding;
        return next;
      });
      resetDraft();
      if (binding.status === "active") toast.success("Additional Secure Link provisioned");
      else if (binding.status === "failed") {
        toast.error(binding.lastError || "Secure Link provisioning failed");
      } else {
        toast.success("Additional Secure Link provisioning started");
      }
    } catch (error) {
      toastApiError(error, "Failed to provision Secure Link");
    } finally {
      setPending(false);
    }
  };

  const retry = async (binding: ProxyAdditionalSecureLink) => {
    setRetryingId(binding.id);
    try {
      const updated = await api.retryProxyAdditionalSecureLink(hostId, binding.id);
      setBindings(
        (current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? [updated]
      );
      if (updated.status === "active") toast.success("Secure Link provisioned");
      else toast.error(updated.lastError || "Secure Link provisioning failed");
    } catch (error) {
      toastApiError(error, "Failed to retry Secure Link");
    } finally {
      setRetryingId(null);
    }
  };

  const remove = (binding: ProxyAdditionalSecureLink) => {
    void confirmAction(
      {
        title: "Remove Additional Secure Link?",
        description: `The binding ${binding.name} will be de-provisioned from both nodes.`,
        confirmLabel: "Remove",
        variant: "destructive",
      },
      async () => {
        let removedIndex = 0;
        hiddenBindingIds.current.add(binding.id);
        setBindings((current) => {
          removedIndex = Math.max(0, current?.findIndex((item) => item.id === binding.id) ?? 0);
          return current?.filter((item) => item.id !== binding.id) ?? [];
        });
        try {
          await api.deleteProxyAdditionalSecureLink(hostId, binding.id);
          toast.success("Additional Secure Link removal started");
          return true;
        } catch (error) {
          hiddenBindingIds.current.delete(binding.id);
          setBindings((current) => {
            if (current?.some((item) => item.id === binding.id)) return current;
            const next = [...(current ?? [])];
            next.splice(removedIndex, 0, binding);
            return next;
          });
          toastApiError(error, "Failed to remove Secure Link");
          return false;
        }
      }
    );
  };

  return (
    <PanelShell
      icon={<Link2 className="h-4 w-4" />}
      title="Additional Secure Link Bindings"
      description="Provision managed upstreams for use in Advanced config"
      className="overflow-visible"
      actions={
        canManage ? (
          <Button onClick={() => setAdding(true)} disabled={pending}>
            <Plus /> Add binding
          </Button>
        ) : null
      }
      wrapHeader
    >
      {bindings === null ? null : bindings.length === 0 ? (
        <EmptyState
          message="No additional bindings. Provision one to reference it from Advanced config."
          embedded
        />
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[900px]">
            <div
              className="grid border-b border-border bg-header text-xs font-medium uppercase tracking-wider text-muted-foreground"
              style={{ gridTemplateColumns: bindingGridTemplate }}
            >
              <div className="px-3 py-2">Name</div>
              <div className="border-l border-border px-3 py-2">Resource</div>
              <div className="border-l border-border px-3 py-2">Port</div>
              <div className="border-l border-border px-3 py-2">Scheme</div>
              <div className="border-l border-border px-3 py-2">Variable</div>
              <div className="border-l border-border px-3 py-2 text-center">Status</div>
              {Array.from({ length: actionColumnCount }, (_, index) => (
                <div key={index} className="border-l border-border" />
              ))}
            </div>
            {bindings.map((binding) => (
              <div
                key={binding.id}
                className="grid border-b border-border last:border-b-0"
                style={{ gridTemplateColumns: bindingGridTemplate }}
              >
                <div className="flex min-w-0 items-center px-3 py-2">
                  <p className="truncate text-sm font-medium">
                    {binding.purpose === "additional_route"
                      ? (binding.managedRoutePath ?? "Managed route")
                      : binding.name}
                  </p>
                </div>
                <div
                  className="flex min-w-0 items-center border-l border-border px-3 py-2"
                  title={
                    binding.lastError ??
                    (binding.upstreamKind === "managed_storage"
                      ? `Managed S3 / ${binding.managedStorageId}`
                      : binding.dockerComposeServiceName
                        ? `Compose / ${binding.dockerComposeServiceName}`
                        : binding.targetContainer)
                  }
                >
                  <p className="truncate text-sm">
                    {binding.upstreamKind === "managed_storage"
                      ? "Managed S3 storage"
                      : binding.dockerComposeServiceName
                        ? `Compose / ${binding.dockerComposeServiceName}`
                        : binding.targetContainer}
                  </p>
                </div>
                <div className="flex min-w-0 items-center border-l border-border px-3 py-2 text-sm">
                  {binding.dockerContainerPort}
                </div>
                <div className="flex min-w-0 items-center border-l border-border px-3 py-2 text-sm">
                  {binding.forwardScheme.toUpperCase()}
                </div>
                <div className="flex min-w-0 items-center border-l border-border px-3 py-2">
                  {binding.purpose === "additional_route" ? (
                    <p className="truncate text-sm text-muted-foreground">
                      Managed by Additional Route
                    </p>
                  ) : (
                    <p className="truncate font-mono text-xs" title={variableFor(binding)}>
                      {variableFor(binding)}
                    </p>
                  )}
                </div>
                <div className="flex min-h-9 items-stretch border-l border-border">
                  <Badge
                    className="h-full w-full self-stretch justify-center rounded-none"
                    variant={
                      binding.status === "failed"
                        ? "destructive"
                        : binding.status === "active"
                          ? "success"
                          : "secondary"
                    }
                  >
                    {binding.status.replace("_", " ")}
                  </Badge>
                </div>
                {actionColumnCount === 2 &&
                  (binding.purpose === "user_managed" && binding.status === "failed" ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-none border-l border-border"
                      onClick={() => void retry(binding)}
                      disabled={!canManage}
                      pending={retryingId === binding.id}
                      aria-label={`Retry ${binding.name}`}
                      title="Retry"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  ) : (
                    <div className="h-9 w-9 border-l border-border" />
                  ))}
                {actionColumnCount >= 1 &&
                  (binding.purpose === "user_managed" &&
                  (binding.status === "active" || binding.status === "failed") ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-none border-l border-border"
                      onClick={() => remove(binding)}
                      disabled={!canManage || removeDisabledReason !== null}
                      aria-label={`Remove ${binding.name}`}
                      title={removeDisabledReason ?? "Remove"}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : (
                    <div className="h-9 w-9 border-l border-border" />
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (pending) return;
          if (open) setAdding(true);
          else resetDraft();
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add Binding</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Connect a Docker workload or managed S3 storage through Relay for use in this Route's
            Advanced config.
          </DialogDescription>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor={`${fieldId}-name`} className="block text-sm font-medium">
                Name
              </label>
              <Input
                id={`${fieldId}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="api"
                aria-invalid={nameInvalid}
                aria-describedby={`${fieldId}-name-help`}
                disabled={pending}
              />
              <p
                id={`${fieldId}-name-help`}
                className={cn(
                  "text-xs",
                  nameInvalid ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {nameInvalid ? (
                  "Start with a letter; use up to 64 letters, numbers and underscores."
                ) : (
                  <>
                    The variable includes the scheme. Use it in Advanced config as{" "}
                    <code className="break-all font-mono">{`proxy_pass {{additionalSecureLinks.${name || "name"}}};`}</code>
                  </>
                )}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${fieldId}-target`} className="block text-sm font-medium">
                Target
              </label>
              <Select
                value={storageTarget ? "managed_storage" : selection.kind}
                onValueChange={(kind) => {
                  setStorageTarget(kind === "managed_storage");
                  if (kind !== "managed_storage")
                    setSelection({
                      ...EMPTY_SELECTION,
                      kind: kind as "docker_container" | "docker_deployment",
                    });
                }}
                disabled={pending}
              >
                <SelectTrigger id={`${fieldId}-target`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="docker_container">Docker container</SelectItem>
                  <SelectItem value="docker_deployment">Docker deployment</SelectItem>
                  {(managedStorageIncluded || storageTarget) && (
                    <SelectItem value="managed_storage">Managed S3 storage</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            {storageTarget ? (
              <div className="space-y-1.5">
                <label htmlFor={`${fieldId}-storage`} className="block text-sm font-medium">
                  Storage
                </label>
                <Combobox
                  id={`${fieldId}-storage`}
                  value={managedStorageId}
                  ariaLabel="Managed S3 storage"
                  onValueChange={(value) => setManagedStorageId(value ?? "")}
                  options={storages.map((storage) => ({ value: storage.id, label: storage.name }))}
                  placeholder={storagesLoading ? "Loading storages..." : "Select storage"}
                  disabled={pending || storagesLoading}
                />
                <p
                  className={cn(
                    "text-xs",
                    storagesError ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {storagesError ??
                    "Private S3 via Relay. No shared network or published port; S3 credentials are still required."}
                </p>
              </div>
            ) : (
              <ProxyUpstreamFields
                layout="form"
                value={selection}
                onChange={setSelection}
                containers={containers}
                disabled={pending}
                allowManual={false}
                showTargetSelect={false}
              />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetDraft} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={provision} disabled={!canProvision} pending={pending}>
              <Plus />
              Provision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelShell>
  );
}
