import { Link2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirmAction } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type {
  ContainerLink,
  ContainerLinkCreateInput,
  ContainerLinkEndpoint,
  DockerContainer,
} from "@/types";
import { ContainerLinkDialog } from "./ContainerLinkDialog";
import {
  buildContainerLinkNames,
  type ContainerLinkNames,
  composeServiceResourceId,
  containerLinkEventMatches,
  containerLinkStatusBadge,
  environmentNames,
  parseComposeServiceResourceId,
} from "./container-link-format";
import { LinkRowTitle, useInLinksPanel, useLinkSource } from "./LinksPanel";

const NO_SERVICES: string[] = [];
const NO_NAMES: ContainerLinkNames = buildContainerLinkNames([], []);

/**
 * Container links of one workload: the private connections it starts (outgoing, editable) and the ones that reach
 * it (incoming, read-only). `type` compose_service takes the Compose project id as `resourceId` and its services.
 */
export function ContainerLinksSection({
  nodeId,
  type,
  resourceId,
  workloadName,
  services = NO_SERVICES,
  canManage,
  canSetEnvironment,
  disabled,
  removeDisabledReason = null,
  onMutationStart,
  onMutationEnd,
  onRecreating,
  onApplied,
}: {
  nodeId: string;
  type: ContainerLinkEndpoint["type"];
  resourceId: string;
  workloadName: string;
  /** Compose services that can start links. */
  services?: string[];
  canManage: boolean;
  /** Setting variable names on a link needs environment access to the workload. */
  canSetEnvironment: boolean;
  disabled?: boolean;
  /** Why removing a link is disabled (the workload's app environment is isolated or shut down). */
  removeDisabledReason?: string | null;
  onMutationStart?: (transition: "updating" | "recreating") => void;
  onMutationEnd?: () => void;
  onRecreating?: () => void | Promise<void>;
  /** A Compose project gets a new revision from a link change. */
  onApplied?: () => void | Promise<void>;
}) {
  const [outgoing, setOutgoing] = useState<ContainerLink[]>([]);
  const [incoming, setIncoming] = useState<ContainerLink[]>([]);
  const [workloads, setWorkloads] = useState<DockerContainer[]>([]);
  const [names, setNames] = useState<ContainerLinkNames>(NO_NAMES);
  const [loading, setLoading] = useState(true);
  // Reloads after a change keep the current rows; only the first load holds the tab.
  const initialLoading = useInitialLoading(loading);
  const [addOpen, setAddOpen] = useState(false);
  const generationRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refs = useMemo(
    () =>
      type === "compose_service"
        ? services.map((service) => composeServiceResourceId(resourceId, service))
        : [resourceId],
    [resourceId, services, type]
  );

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const list = (direction: "outgoing" | "incoming") =>
        Promise.all(
          refs.map((ref) => api.listContainerLinks({ nodeId, type, resourceId: ref, direction }))
        ).then((groups) => groups.flat());
      const [nextOutgoing, nextIncoming] = await Promise.all([list("outgoing"), list("incoming")]);
      if (generation !== generationRef.current) return;
      setOutgoing(nextOutgoing);
      setIncoming(nextIncoming);
    } catch (error) {
      if (generation === generationRef.current) {
        toast.error(error instanceof Error ? error.message : "Failed to load container links");
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [nodeId, refs, type]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current++;
    };
  }, [load]);

  // Names and nodes are display detail; the rows fall back to ids without them.
  const loadNames = useCallback(async () => {
    const [nextWorkloads, projects] = await Promise.all([
      api.listDockerContainerSnapshots().catch(() => []),
      api.listDockerComposeProjects().catch(() => []),
    ]);
    setWorkloads(nextWorkloads);
    setNames(buildContainerLinkNames(nextWorkloads, projects));
  }, []);

  useEffect(() => {
    void loadNames();
  }, [loadNames]);

  const scheduleLoad = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void load();
    }, 250);
  }, [load]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    },
    []
  );

  useRealtime(
    "docker.container.changed",
    (payload) => {
      if (containerLinkEventMatches(payload, nodeId, type, resourceId)) scheduleLoad();
    },
    { onReconnect: scheduleLoad }
  );

  useContentLoading(initialLoading);

  const sources = useMemo(
    () =>
      type === "compose_service"
        ? services.map((service) => ({
            resourceId: composeServiceResourceId(resourceId, service),
            label: service,
          }))
        : [{ resourceId, label: workloadName }],
    [resourceId, services, type, workloadName]
  );

  const openAddDialog = () => {
    if (!requireLicenseFeature("container-links", "Container links")) return;
    setAddOpen(true);
  };

  // Variables on a link recreate its workload once; without them the link attaches live.
  const finishMutation = async (restarts: boolean, message: string) => {
    toast.success(restarts ? `${message} — recreating workload` : message);
    await load();
    if (restarts) void Promise.resolve(onRecreating?.());
    await onApplied?.();
  };

  const createLink = async (input: ContainerLinkCreateInput) => {
    const restarts = environmentNames(input.environment).length > 0;
    if (restarts) onMutationStart?.("recreating");
    try {
      await api.createContainerLink(input);
    } catch (error) {
      if (restarts) onMutationEnd?.();
      // The link may exist in an error state even though creating it failed.
      void load();
      if (!handleLicenseApiError(error, "Container links")) {
        toast.error(error instanceof Error ? error.message : "Failed to add the container link");
      }
      return false;
    }
    await finishMutation(restarts, "Container link added");
    return true;
  };

  const removeLink = (link: ContainerLink) => {
    const restarts = environmentNames(link.environment).length > 0;
    const target = names.endpoint(link.target).name;
    void confirmAction(
      {
        title: "Remove container link",
        description: `${workloadName} will no longer reach ${target} as ${link.alias}:${link.targetPort}.${
          restarts ? ` Its link variables are removed and it is recreated.` : ""
        }`,
        confirmLabel: "Remove",
        variant: "destructive",
      },
      async () => {
        if (restarts) onMutationStart?.("recreating");
        try {
          await api.deleteContainerLink(link.id);
        } catch (error) {
          if (restarts) onMutationEnd?.();
          toast.error(
            error instanceof Error ? error.message : "Failed to remove the container link"
          );
          return false;
        }
        await finishMutation(restarts, "Container link removed");
        return true;
      }
    );
  };

  const statusBadge = (link: ContainerLink) => {
    const badge = containerLinkStatusBadge(link);
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant={badge.variant} tabIndex={0}>
              {badge.label}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-sm">
            {badge.detail}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  // In the shared Links panel this section adds its outgoing and incoming rows and its add
  // action there; container links apply at once, so it has no draft.
  const inLinksPanel = useInLinksPanel();
  useLinkSource("container", {
    rowCount: initialLoading ? 0 : outgoing.length + incoming.length,
    loading: initialLoading,
    add: canManage
      ? { disabled: Boolean(disabled) || loading || sources.length === 0, open: openAddDialog }
      : undefined,
  });

  const outgoingRows = outgoing.map((link) => {
    const target = names.endpoint(link.target);
    const service =
      link.source.type === "compose_service"
        ? parseComposeServiceResourceId(link.source.resourceId).serviceName
        : "";
    const description = [
      target.nodeName,
      service ? `from ${service}` : "",
      environmentNames(link.environment).length > 0
        ? `sets ${environmentNames(link.environment).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <SettingsControlRow
        key={link.id}
        title={
          <LinkRowTitle kind="container">{`${link.alias}:${link.targetPort} → ${target.name}`}</LinkRowTitle>
        }
        description={description || undefined}
      >
        <div className="flex items-center gap-2">
          {statusBadge(link)}
          {canManage && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={removeDisabledReason ?? "Remove link"}
              aria-label={`Remove link ${link.alias}`}
              disabled={disabled || removeDisabledReason !== null}
              onClick={() => removeLink(link)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </SettingsControlRow>
    );
  });
  const incomingRows = incoming.map((link) => {
    const source = names.endpoint(link.source);
    return (
      <SettingsControlRow
        key={link.id}
        title={<LinkRowTitle kind="container">{source.name}</LinkRowTitle>}
        description={[
          inLinksPanel ? "Incoming" : "",
          source.nodeName,
          `as ${link.alias}:${link.targetPort}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        {statusBadge(link)}
      </SettingsControlRow>
    );
  });

  const dialog = (
    <ContainerLinkDialog
      open={addOpen}
      onOpenChange={setAddOpen}
      sourceNodeId={nodeId}
      sourceType={type}
      sources={sources}
      workloadName={workloadName}
      workloads={workloads}
      canSetEnvironment={canSetEnvironment}
      onCreate={createLink}
    />
  );

  if (inLinksPanel) {
    return (
      <>
        {initialLoading ? null : outgoingRows}
        {initialLoading ? null : incomingRows}
        {dialog}
      </>
    );
  }

  return (
    <>
      <PanelShell
        title="Container Links"
        icon={<Link2 className="h-4 w-4" />}
        description="Private connections to a port of another container, deployment or Compose service. No published port is needed."
        bodyClassName={outgoing.length > 0 ? "divide-y divide-border" : undefined}
        actions={
          canManage ? (
            <Button
              type="button"
              disabled={disabled || loading || sources.length === 0}
              onClick={openAddDialog}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          ) : undefined
        }
      >
        {initialLoading ? null : outgoing.length === 0 ? (
          <EmptyState message="No container links" embedded />
        ) : (
          outgoingRows
        )}
      </PanelShell>

      {!initialLoading && incoming.length > 0 && (
        <PanelShell
          title="Incoming Links"
          icon={<Link2 className="h-4 w-4" />}
          description={`Workloads that reach ${workloadName}. Manage a link from the workload that starts it.`}
          bodyClassName="divide-y divide-border"
        >
          {incomingRows}
        </PanelShell>
      )}

      {dialog}
    </>
  );
}
