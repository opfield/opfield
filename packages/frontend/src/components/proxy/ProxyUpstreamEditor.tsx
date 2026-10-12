import { Network, Save } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { PagesTargetPicker } from "@/components/proxy/PagesTargetPicker";
import {
  UpstreamField,
  type UpstreamFieldLayout,
  UpstreamFieldPair,
} from "@/components/proxy/upstream-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { api } from "@/services/api";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type {
  CreateProxyHostRequest,
  DockerComposeProject,
  DockerContainer,
  ForwardScheme,
  PageProject,
  PageTag,
  ProxyHost,
  ProxyUpstreamKind,
} from "@/types";

export interface ProxyUpstreamSelection {
  kind: ProxyUpstreamKind;
  scheme: ForwardScheme;
  manualHost: string;
  manualPort: number;
  dockerNodeId: string | null;
  containerName: string | null;
  composeProjectId: string | null;
  composeServiceName: string | null;
  deploymentId: string | null;
  containerPort: number | null;
  pageProjectId?: string;
  pageTagId?: string;
  pageProjectLabel?: string;
  pageTagLabel?: string;
}

interface ApplicationPort {
  containerPort: number;
}

export const DEFAULT_PROXY_UPSTREAM: ProxyUpstreamSelection = {
  kind: "manual",
  scheme: "http",
  manualHost: "",
  manualPort: 80,
  dockerNodeId: null,
  containerName: null,
  composeProjectId: null,
  composeServiceName: null,
  deploymentId: null,
  containerPort: null,
  pageProjectId: "",
  pageTagId: "",
};

export function proxyUpstreamFromHost(host: ProxyHost): ProxyUpstreamSelection {
  return {
    kind: host.upstreamKind ?? "manual",
    scheme: host.forwardScheme ?? "http",
    manualHost: host.upstreamKind === "manual" ? host.forwardHost || "" : "",
    manualPort: host.upstreamKind === "manual" ? host.forwardPort || 80 : 80,
    dockerNodeId: host.dockerNodeId ?? null,
    containerName: host.dockerComposeProjectId ? null : (host.dockerContainerName ?? null),
    composeProjectId: host.dockerComposeProjectId ?? null,
    composeServiceName: host.dockerComposeServiceName ?? null,
    deploymentId: host.dockerDeploymentId ?? null,
    containerPort: host.dockerContainerPort ?? null,
    pageProjectId: host.pageTarget?.projectId ?? "",
    pageTagId: host.pageTarget?.tagId ?? "",
    pageProjectLabel: host.pageTarget
      ? `${host.pageTarget.projectName} · ${host.pageTarget.projectSlug}`
      : undefined,
    pageTagLabel: host.pageTarget?.tagName,
  };
}

export function proxyUpstreamRequest(
  selection: ProxyUpstreamSelection
): Partial<CreateProxyHostRequest> {
  if (selection.kind === "manual") {
    return {
      upstreamKind: "manual",
      forwardHost: selection.manualHost.trim(),
      forwardPort: selection.manualPort,
      forwardScheme: selection.scheme,
    };
  }
  if (selection.kind === "docker_container") {
    // Clear the other target mode explicitly: omitted fields keep their stored
    // value on update, so a Compose -> named container switch would be ignored.
    return {
      upstreamKind: "docker_container",
      forwardScheme: selection.scheme,
      ...(selection.dockerNodeId ? { dockerNodeId: selection.dockerNodeId } : {}),
      ...(selection.containerName
        ? {
            dockerContainerName: selection.containerName,
            dockerComposeProjectId: null,
            dockerComposeServiceName: null,
          }
        : selection.composeProjectId && selection.composeServiceName
          ? {
              dockerContainerName: null,
              dockerComposeProjectId: selection.composeProjectId,
              dockerComposeServiceName: selection.composeServiceName,
            }
          : {}),
      ...(selection.containerPort != null ? { dockerContainerPort: selection.containerPort } : {}),
      dockerProtocol: "tcp",
    };
  }
  if (selection.kind === "pages") {
    return {
      upstreamKind: "pages",
      pageProjectId: selection.pageProjectId ?? "",
      pageTagId: selection.pageTagId ?? "",
    };
  }
  return {
    upstreamKind: "docker_deployment",
    forwardScheme: selection.scheme,
    ...(selection.deploymentId ? { dockerDeploymentId: selection.deploymentId } : {}),
    ...(selection.containerPort != null ? { dockerContainerPort: selection.containerPort } : {}),
    dockerProtocol: "tcp",
  };
}

export function isProxyUpstreamValid(selection: ProxyUpstreamSelection): boolean {
  if (selection.kind === "manual") {
    return selection.manualHost.trim().length > 0 && selection.manualPort > 0;
  }
  if (
    selection.kind === "docker_container" &&
    (!selection.dockerNodeId ||
      (!selection.containerName && (!selection.composeProjectId || !selection.composeServiceName)))
  ) {
    return false;
  }
  if (selection.kind === "docker_deployment" && !selection.deploymentId) return false;
  if (selection.kind === "pages") return !!selection.pageProjectId && !!selection.pageTagId;
  return !!selection.containerPort;
}

/**
 * Ports to offer for a container: the declared TCP ports it also listens on, else the ports it
 * listens on (an image may declare none, or the wrong one), else the declared ports.
 */
function applicationTcpPorts(container: DockerContainer): ApplicationPort[] {
  const declared = [
    ...new Set(
      (container.ports ?? [])
        .filter((port) => port.type.toLowerCase() === "tcp" && port.privatePort)
        .map((port) => port.privatePort)
    ),
  ];
  const listening = container.listeningPorts ?? [];
  const declaredListening = declared.filter((port) => listening.includes(port));
  const ports =
    declaredListening.length > 0 ? declaredListening : listening.length > 0 ? listening : declared;
  return ports.map((containerPort) => ({ containerPort }));
}

function targetKey(container: DockerContainer): string {
  if (container.kind === "deployment")
    return `deployment:${container.deploymentId ?? container.id}`;
  return `container:${container.nodeId ?? container._nodeId ?? ""}:${container.name}`;
}

function selectedTargetKey(selection: ProxyUpstreamSelection): string {
  if (selection.kind === "docker_deployment" && selection.deploymentId) {
    return `deployment:${selection.deploymentId}`;
  }
  if (selection.kind === "docker_container" && selection.dockerNodeId && selection.containerName) {
    return `container:${selection.dockerNodeId}:${selection.containerName}`;
  }
  if (
    selection.kind === "docker_container" &&
    selection.dockerNodeId &&
    selection.composeProjectId &&
    selection.composeServiceName
  ) {
    return `compose:${selection.dockerNodeId}:${selection.composeProjectId}:${encodeURIComponent(selection.composeServiceName)}`;
  }
  return "__none__";
}

export function proxyUpstreamForDockerTarget(
  current: ProxyUpstreamSelection,
  target: DockerContainer
): ProxyUpstreamSelection {
  const ports = applicationTcpPorts(target);
  const onlyPort = ports.length === 1 ? ports[0]! : null;
  const nodeId = target.nodeId ?? target._nodeId ?? null;
  if (target.kind === "deployment") {
    return {
      ...current,
      kind: "docker_deployment",
      dockerNodeId: null,
      containerName: null,
      composeProjectId: null,
      composeServiceName: null,
      deploymentId: target.deploymentId ?? target.id,
      containerPort: onlyPort?.containerPort ?? null,
    };
  }
  return {
    ...current,
    kind: "docker_container",
    dockerNodeId: nodeId,
    containerName: target.name,
    composeProjectId: null,
    composeServiceName: null,
    deploymentId: null,
    containerPort: onlyPort?.containerPort ?? null,
  };
}

export function ProxyUpstreamFields({
  value,
  onChange,
  containers,
  disabled = false,
  allowManual = true,
  showTargetSelect = true,
  showScheme = true,
  resourceDescription = "Container or deployment reached through Secure Link",
  portDescription = "TCP port the container listens on or declares, or one entered manually",
  layout = "rows",
}: {
  value: ProxyUpstreamSelection;
  onChange: (value: ProxyUpstreamSelection) => void;
  containers: DockerContainer[];
  disabled?: boolean;
  allowManual?: boolean;
  showTargetSelect?: boolean;
  /** The HTTP scheme only matters to routes; other callers (container links) hide it. */
  showScheme?: boolean;
  resourceDescription?: string;
  portDescription?: string;
  /** Settings rows (default) or stacked form fields for form dialogs. */
  layout?: UpstreamFieldLayout;
}) {
  const fieldId = useId();
  const [composeProjects, setComposeProjects] = useState<DockerComposeProject[]>([]);
  const selectedContainer = useMemo(
    () => containers.find((container) => targetKey(container) === selectedTargetKey(value)) ?? null,
    [containers, value]
  );
  const [pageProjects, setPageProjects] = useState<PageProject[]>([]);
  const [pageTags, setPageTags] = useState<PageTag[]>([]);
  const pagesEnabled = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.pagesEnabled === true
  );
  // Option lists load for the current target kind; the flags start true when the
  // first render already needs them, so the enclosing gate waits for them.
  const [composeLoading, setComposeLoading] = useState(value.kind === "docker_container");
  const [pageProjectsLoading, setPageProjectsLoading] = useState(
    value.kind === "pages" && pagesEnabled
  );
  const [pageTagsLoading, setPageTagsLoading] = useState(
    value.kind === "pages" && pagesEnabled && Boolean(value.pageProjectId)
  );
  // Compose details load one project at a time; the gate waits for them only
  // when the current target is a Compose service that needs them to display.
  useContentLoading(
    (composeLoading && selectedTargetKey(value).startsWith("compose:")) ||
      pageProjectsLoading ||
      pageTagsLoading
  );

  useEffect(() => {
    if (value.kind !== "docker_container") {
      setComposeLoading(false);
      return;
    }
    let cancelled = false;
    setComposeLoading(true);
    void api
      .listDockerComposeProjects()
      .then((projects) =>
        Promise.all(
          projects.map((project) =>
            api.getDockerComposeProject(project.nodeId, project.id).catch(() => null)
          )
        )
      )
      .then((projects) => {
        if (!cancelled) setComposeProjects(projects.filter(Boolean) as DockerComposeProject[]);
      })
      .catch(() => {
        if (!cancelled) setComposeProjects([]);
      })
      .finally(() => {
        if (!cancelled) setComposeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [value.kind]);

  useEffect(() => {
    if (value.kind !== "pages") return;
    if (!pagesEnabled) {
      setPageProjects([]);
      setPageProjectsLoading(false);
      return;
    }
    setPageProjectsLoading(true);
    void api
      .listPageProjects({ page: 1, limit: 100 })
      .then((response) => setPageProjects(response.data ?? []))
      .catch(() => setPageProjects([]))
      .finally(() => setPageProjectsLoading(false));
  }, [pagesEnabled, value.kind]);

  useEffect(() => {
    if (value.kind !== "pages" || !value.pageProjectId || !pagesEnabled) {
      setPageTags([]);
      setPageTagsLoading(false);
      return;
    }
    setPageTagsLoading(true);
    void api
      .listPageTags(value.pageProjectId)
      .then(setPageTags)
      .catch(() => setPageTags([]))
      .finally(() => setPageTagsLoading(false));
  }, [pagesEnabled, value.kind, value.pageProjectId]);
  const candidates = useMemo(() => {
    const result = [...containers];
    const hasReferencedContainer =
      value.kind === "docker_container" && !!value.dockerNodeId && !!value.containerName;
    if (!selectedContainer && hasReferencedContainer) {
      result.push({
        id: `${value.dockerNodeId}:${value.containerName}`,
        name: value.containerName!,
        image: "",
        state: "",
        status: "",
        created: 0,
        ports: value.containerPort
          ? [{ privatePort: value.containerPort, publicPort: 0, type: "tcp" }]
          : [],
        kind: "container",
        nodeId: value.dockerNodeId ?? undefined,
        availability: "unavailable",
      });
    }
    return result;
  }, [containers, selectedContainer, value]);
  const effectiveSelectedContainer = useMemo(
    () => candidates.find((container) => targetKey(container) === selectedTargetKey(value)) ?? null,
    [candidates, value]
  );
  const composeCandidates = useMemo(
    () =>
      composeProjects.flatMap((project) =>
        Object.entries(project.activeRevision?.normalizedModel.services ?? {}).map(
          ([serviceName, service]) => ({
            key: `compose:${project.nodeId}:${project.id}:${encodeURIComponent(serviceName)}`,
            projectId: project.id,
            projectName: project.name,
            serviceName,
            nodeId: project.nodeId,
            nodeName: project._nodeName,
            nodeSlug: project._nodeSlug,
            nodeColor: project._nodeColor,
            unavailable: project.availability === "unavailable" || project.status === "missing",
            ports: (service.ports ?? [])
              .filter((port) => (port.protocol ?? "tcp") === "tcp")
              .map((port) => ({ containerPort: port.target })),
          })
        )
      ),
    [composeProjects]
  );
  const selectedCompose = useMemo(
    () => composeCandidates.find((candidate) => candidate.key === selectedTargetKey(value)) ?? null,
    [composeCandidates, value]
  );
  const resourceCandidates = useMemo(
    () =>
      candidates.filter((candidate) =>
        value.kind === "docker_deployment"
          ? candidate.kind === "deployment"
          : candidate.kind !== "deployment"
      ),
    [candidates, value.kind]
  );
  const resourceOptions = useMemo<ComboboxOption[]>(
    () => [
      ...resourceCandidates.map((candidate) => ({
        value: targetKey(candidate),
        label: candidate.name,
        keywords: [candidate._nodeName, candidate._nodeSlug].filter(Boolean).join(" "),
        disabled: candidate.availability === "unavailable",
      })),
      ...(value.kind === "docker_container"
        ? composeCandidates.map((candidate) => ({
            value: candidate.key,
            label: `${candidate.projectName} / ${candidate.serviceName}`,
            keywords: [
              candidate.projectName,
              candidate.serviceName,
              candidate.nodeName,
              candidate.nodeSlug,
            ]
              .filter(Boolean)
              .join(" "),
            disabled: candidate.unavailable,
          }))
        : []),
    ],
    [composeCandidates, resourceCandidates, value.kind]
  );
  const chooseTarget = (key: string) => {
    const compose = composeCandidates.find((candidate) => candidate.key === key);
    if (compose) {
      onChange({
        ...value,
        kind: "docker_container",
        dockerNodeId: compose.nodeId,
        containerName: null,
        composeProjectId: compose.projectId,
        composeServiceName: compose.serviceName,
        deploymentId: null,
        containerPort: compose.ports.length === 1 ? compose.ports[0]!.containerPort : null,
      });
      return;
    }
    const target = candidates.find((candidate) => targetKey(candidate) === key);
    if (!target) return;
    onChange(proxyUpstreamForDockerTarget(value, target));
  };

  return (
    <>
      {showTargetSelect ? (
        <UpstreamField
          layout={layout}
          id={`${fieldId}-target`}
          title="Target"
          description="Choose how requests reach the upstream"
        >
          <Select
            value={value.kind}
            onValueChange={(kind) => {
              onChange({
                ...DEFAULT_PROXY_UPSTREAM,
                scheme: value.scheme,
                kind: kind as ProxyUpstreamKind,
              });
            }}
            disabled={disabled}
          >
            <SelectTrigger id={`${fieldId}-target`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allowManual ? <SelectItem value="manual">Manual address</SelectItem> : null}
              <SelectItem value="docker_container">Docker container</SelectItem>
              <SelectItem value="docker_deployment">Docker deployment</SelectItem>
              {/* Pages is offered only while enabled; an existing Pages target stays shown. */}
              {(pagesEnabled || value.kind === "pages") && (
                <SelectItem value="pages">Pages</SelectItem>
              )}
            </SelectContent>
          </Select>
        </UpstreamField>
      ) : null}

      {value.kind === "pages" ? (
        <PagesTargetPicker
          projectId={value.pageProjectId ?? ""}
          tagId={value.pageTagId ?? ""}
          onProjectChange={(pageProjectId) => onChange({ ...value, pageProjectId, pageTagId: "" })}
          onTagChange={(pageTagId) => onChange({ ...value, pageTagId })}
          projects={pageProjects}
          tags={pageTags}
          projectsLoading={pageProjectsLoading}
          tagsLoading={pageTagsLoading}
          disabled={disabled || !pagesEnabled}
          selectedProjectLabel={value.pageProjectLabel}
          selectedTagLabel={value.pageTagLabel}
          layout={layout}
        />
      ) : value.kind === "manual" ? (
        <>
          <UpstreamField
            layout={layout}
            id={`${fieldId}-host`}
            title="Forward Host"
            description="Hostname or IP address of the upstream"
            controlsClassName="sm:w-full"
          >
            <Input
              id={`${fieldId}-host`}
              value={value.manualHost}
              onChange={(event) => onChange({ ...value, manualHost: event.target.value })}
              placeholder="192.168.1.100"
              disabled={disabled}
            />
          </UpstreamField>
          <UpstreamFieldPair layout={layout}>
            <UpstreamField
              layout={layout}
              id={`${fieldId}-port`}
              title="Forward Port"
              description="Upstream service port"
              controlsClassName="sm:w-full"
            >
              <NumericInput
                id={`${fieldId}-port`}
                value={value.manualPort}
                onChange={(manualPort) => onChange({ ...value, manualPort })}
                min={1}
                max={65535}
                disabled={disabled}
              />
            </UpstreamField>
            <UpstreamField
              layout={layout}
              id={`${fieldId}-scheme`}
              title="Scheme"
              description="Protocol used to reach the upstream"
              controlsClassName="sm:w-full"
            >
              <SchemeSelect
                id={`${fieldId}-scheme`}
                value={value}
                onChange={onChange}
                disabled={disabled}
              />
            </UpstreamField>
          </UpstreamFieldPair>
        </>
      ) : (
        <>
          <UpstreamField
            layout={layout}
            id={`${fieldId}-resource`}
            title="Docker Resource"
            description={resourceDescription}
            controlsClassName="sm:w-full"
          >
            <Combobox
              id={`${fieldId}-resource`}
              value={selectedTargetKey(value)}
              options={resourceOptions}
              onValueChange={chooseTarget}
              contentClassName="right-0 left-auto max-h-64"
              placeholder="Select a resource..."
              searchPlaceholder={
                value.kind === "docker_deployment"
                  ? "Search deployments..."
                  : "Search containers..."
              }
              emptyMessage="No matching resources."
              disabled={disabled}
              renderOption={(option) => {
                const compose = composeCandidates.find(
                  (candidate) => candidate.key === option.value
                );
                if (compose) {
                  return (
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate">
                        {compose.projectName} / {compose.serviceName}
                      </span>
                      <Badge variant="secondary" size="inline">
                        Compose
                      </Badge>
                      {(compose.nodeName || compose.nodeSlug) && (
                        <Badge
                          variant="secondary"
                          size="inline"
                          className={nodeBadgeClassName(compose.nodeColor)}
                        >
                          {compose.nodeName ?? compose.nodeSlug}
                        </Badge>
                      )}
                      {compose.unavailable && (
                        <Badge variant="secondary" size="inline">
                          Unavailable
                        </Badge>
                      )}
                    </span>
                  );
                }
                const candidate = resourceCandidates.find(
                  (resource) => targetKey(resource) === option.value
                );
                if (!candidate) return option.label;
                const ports = applicationTcpPorts(candidate);
                const unavailable = candidate.availability === "unavailable";
                return (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{candidate.name}</span>
                    {(candidate._nodeName || candidate._nodeSlug) && (
                      <Badge
                        variant="secondary"
                        size="inline"
                        className={nodeBadgeClassName(candidate._nodeColor)}
                      >
                        {candidate._nodeName ?? candidate._nodeSlug}
                      </Badge>
                    )}
                    {unavailable && (
                      <Badge variant="secondary" size="inline">
                        Unavailable
                      </Badge>
                    )}
                    {!unavailable && ports.length === 0 && (
                      <Badge variant="secondary" size="inline">
                        No TCP ports
                      </Badge>
                    )}
                  </span>
                );
              }}
            />
          </UpstreamField>
          <UpstreamFieldPair layout={showScheme ? layout : "rows"}>
            <UpstreamField
              layout={layout}
              id={`${fieldId}-container-port`}
              title="Application Port"
              description={portDescription}
              controlsClassName="sm:w-full"
            >
              <Input
                id={`${fieldId}-container-port`}
                type="number"
                min={1}
                max={65535}
                value={value.containerPort ?? ""}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  onChange({
                    ...value,
                    containerPort: Number.isInteger(parsed) && parsed > 0 ? parsed : null,
                  });
                }}
                placeholder="8080"
                disabled={disabled || (!effectiveSelectedContainer && !selectedCompose)}
              />
            </UpstreamField>
            {showScheme ? (
              <UpstreamField
                layout={layout}
                id={`${fieldId}-scheme`}
                title="Scheme"
                description="Protocol used to reach the upstream"
                controlsClassName="sm:w-full"
              >
                <SchemeSelect
                  id={`${fieldId}-scheme`}
                  value={value}
                  onChange={onChange}
                  disabled={disabled}
                />
              </UpstreamField>
            ) : null}
          </UpstreamFieldPair>
        </>
      )}
    </>
  );
}

function SchemeSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: ProxyUpstreamSelection;
  onChange: (value: ProxyUpstreamSelection) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value.scheme}
      onValueChange={(scheme) => onChange({ ...value, scheme: scheme as ForwardScheme })}
      disabled={disabled}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="http">HTTP</SelectItem>
        <SelectItem value="https">HTTPS</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function ProxyUpstreamPanel({
  host,
  canManage,
  onUpdated,
}: {
  host: ProxyHost;
  canManage: boolean;
  onUpdated: (host: ProxyHost) => void;
}) {
  const [selection, setSelection] = useState(() => proxyUpstreamFromHost(host));
  const [relaySpreadMode, setRelaySpreadMode] = useState<"inherit" | "fixed" | "all">(
    host.relaySpreadMode ?? "inherit"
  );
  const [relaySpreadCount, setRelaySpreadCount] = useState(host.relaySpreadCount ?? 2);
  const [upstreamIpv6Enabled, setUpstreamIpv6Enabled] = useState(host.upstreamIpv6Enabled ?? false);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [containersLoading, setContainersLoading] = useState(true);
  useContentLoading(containersLoading);
  const [saving, setSaving] = useState(false);
  const persistedDraft = useMemo(
    () => ({
      hostId: host.id,
      selection: proxyUpstreamFromHost(host),
      relaySpreadMode: host.relaySpreadMode ?? ("inherit" as const),
      relaySpreadCount: host.relaySpreadCount ?? 2,
      upstreamIpv6Enabled: host.upstreamIpv6Enabled ?? false,
    }),
    [host]
  );
  const lastPersistedDraft = useRef(persistedDraft);

  const loadContainers = useCallback(() => {
    void api
      .listDockerContainerSnapshots()
      .then(setContainers)
      .catch(() => setContainers([]))
      .finally(() => setContainersLoading(false));
  }, []);

  useEffect(() => {
    const previous = lastPersistedDraft.current;
    const hasLocalChanges =
      JSON.stringify(proxyUpstreamRequest(selection)) !==
        JSON.stringify(proxyUpstreamRequest(previous.selection)) ||
      relaySpreadMode !== previous.relaySpreadMode ||
      upstreamIpv6Enabled !== previous.upstreamIpv6Enabled ||
      (relaySpreadMode === "fixed" && relaySpreadCount !== previous.relaySpreadCount);
    lastPersistedDraft.current = persistedDraft;
    if (persistedDraft.hostId !== previous.hostId || !hasLocalChanges) {
      setSelection(persistedDraft.selection);
      setRelaySpreadMode(persistedDraft.relaySpreadMode);
      setRelaySpreadCount(persistedDraft.relaySpreadCount);
      setUpstreamIpv6Enabled(persistedDraft.upstreamIpv6Enabled);
    }
  }, [persistedDraft, relaySpreadCount, relaySpreadMode, selection, upstreamIpv6Enabled]);
  useEffect(loadContainers, [loadContainers]);
  useRealtime("docker.snapshot.changed", loadContainers);
  useRealtime("docker.deployment.changed", loadContainers);

  const changed = useMemo(
    () =>
      JSON.stringify(proxyUpstreamRequest(selection)) !==
        JSON.stringify(proxyUpstreamRequest(persistedDraft.selection)) ||
      relaySpreadMode !== persistedDraft.relaySpreadMode ||
      upstreamIpv6Enabled !== persistedDraft.upstreamIpv6Enabled ||
      (relaySpreadMode === "fixed" && relaySpreadCount !== persistedDraft.relaySpreadCount),
    [persistedDraft, relaySpreadCount, relaySpreadMode, selection, upstreamIpv6Enabled]
  );

  const relaySpreadValid =
    relaySpreadMode !== "fixed" || (relaySpreadCount >= 1 && relaySpreadCount <= 64);

  const save = async () => {
    if (!canManage || !isProxyUpstreamValid(selection) || !relaySpreadValid) return;
    setSaving(true);
    try {
      const updated = await api.updateProxyHost(host.id, {
        ...proxyUpstreamRequest(selection),
        relaySpreadMode,
        relaySpreadCount: relaySpreadMode === "fixed" ? relaySpreadCount : null,
        upstreamIpv6Enabled,
      });
      onUpdated(updated);
      toast.success("Upstream updated");
    } catch (error) {
      toastApiError(error, "Failed to update upstream");
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelShell
      icon={<Network className="h-4 w-4" />}
      title="Upstream"
      description="Route traffic manually, to Docker, or Pages"
      className="overflow-visible"
      dirty={changed}
      actions={
        canManage ? (
          <Button
            className="w-fit"
            onClick={save}
            disabled={!changed || !isProxyUpstreamValid(selection) || !relaySpreadValid}
            pending={saving}
          >
            <Save />
            Save
          </Button>
        ) : null
      }
      wrapHeader
    >
      <ProxyUpstreamFields
        value={selection}
        onChange={setSelection}
        containers={containers}
        disabled={!canManage}
      />
      {selection.kind === "manual" ? (
        <SettingsControlRow
          title="Enable IPv6 support"
          description="Allow this upstream hostname to resolve and connect over IPv6"
          help="Enables AAAA resolution and IPv6 connections for a manually configured hostname. Keep disabled when the upstream or network path is IPv4-only."
        >
          <Switch
            checked={upstreamIpv6Enabled}
            onChange={setUpstreamIpv6Enabled}
            disabled={!canManage || saving}
            ariaLabel="Enable IPv6 support"
          />
        </SettingsControlRow>
      ) : null}
      <SettingsControlRow
        title="Relay spread"
        description="Relay capacity used by this workload and all its Secure Links; existing connections stay pinned"
        help="Controls how many ready Relay instances may accept new connections for this workload. Changing it affects new connections only; active streams remain on their current Relay."
        controlsClassName="sm:w-96 sm:min-w-96 sm:max-w-96"
      >
        <div className="flex w-full items-center gap-2">
          <Select
            value={relaySpreadMode}
            onValueChange={(value) => setRelaySpreadMode(value as "inherit" | "fixed" | "all")}
            disabled={!canManage || saving}
          >
            <SelectTrigger className="min-w-0 flex-1" aria-label="Workload relay spread mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">Use pool default</SelectItem>
              <SelectItem value="fixed">Fixed count</SelectItem>
              <SelectItem value="all">All ready relays</SelectItem>
            </SelectContent>
          </Select>
          {relaySpreadMode === "fixed" && (
            <NumericInput
              value={relaySpreadCount}
              onChange={setRelaySpreadCount}
              min={1}
              max={64}
              disabled={!canManage || saving}
              aria-label="Workload relay count"
              className="w-24 shrink-0"
            />
          )}
        </div>
      </SettingsControlRow>
    </PanelShell>
  );
}
