import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AppEnvironmentFields,
  allowedNodesHint,
  NoAllowedNodeNotice,
} from "@/components/apps/AppEnvironmentFields";
import {
  type AppCreateContext,
  allowedAppNodes,
  appPlacementFolderId,
  rememberAppCreation,
  useAppEnvironmentChoice,
} from "@/components/apps/app-create-context";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { Combobox } from "@/components/common/Combobox";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SwitchCard } from "@/components/common/SwitchCard";
import { DomainAutocompleteInput } from "@/components/domains/DomainAutocompleteInput";
import { type IngressTarget, IngressTargetSelect } from "@/components/proxy/IngressTargetSelect";
import {
  DEFAULT_PROXY_UPSTREAM,
  isProxyUpstreamValid,
  ProxyUpstreamFields,
  type ProxyUpstreamSelection,
  proxyUpstreamFromHost,
  proxyUpstreamRequest,
} from "@/components/proxy/ProxyUpstreamEditor";
import { REDIRECT_STATUS_OPTIONS } from "@/components/proxy/redirect-status-options";
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
import { toastApiError } from "@/lib/api-error-toast";
import {
  allowedCreationFolderId,
  type CreationFolderOption,
  creationFolderChoices,
  flattenCreationFolders,
} from "@/lib/creation-folders";
import { pickerLoadError } from "@/lib/picker-load-error";
import { supportsPagesRouteTemplate } from "@/lib/proxy-template-capabilities";
import { canCreateInFolder } from "@/lib/scope-utils";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { planIncludes } from "@/stores/license-paywall";
import type {
  CreateProxyHostRequest,
  DockerContainer,
  NginxTemplate,
  Node,
  ProxyHost,
  ProxyHostType,
  RouteIngressGroupOption,
  SSLCertificate,
} from "@/types";
import { isNodeIncompatible } from "@/types";

interface CreateProxyHostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When editing, pre-fill with existing host data */
  existingHost?: ProxyHost | null;
  /** Optional entrypoint defaults when creating a route from a registered domain. */
  initialDomainName?: string;
  initialNodeId?: string;
  /** Create the route on this ingress group (a domain served by the group). */
  initialIngressGroupId?: string;
  /** Create the route to this upstream, e.g. a Pages project. */
  initialUpstream?: ProxyUpstreamSelection;
  /** Called on successful create/update with the host ID and returned host payload when available. */
  onSuccess?: (hostId: string, host?: ProxyHost) => void;
  /**
   * Create from an app: locked App field, environment select, only the environment's allowed
   * nginx nodes and the ingress groups whose members are all allowed, created in the
   * environment's placement folder.
   */
  appContext?: AppCreateContext;
}
interface NodeOption {
  id: string;
  hostname: string;
  status: string;
  type: string;
  serviceCreationLocked: boolean;
}

function mapNodeOptions(nodes: Node[]): NodeOption[] {
  return nodes
    .filter((node) => node.type === "nginx" && !isNodeIncompatible(node))
    .map((node) => ({
      id: node.id,
      hostname: node.displayName || node.hostname,
      status: node.status,
      type: node.type,
      serviceCreationLocked: node.serviceCreationLocked,
    }));
}

function getCachedNodeOptions(): NodeOption[] {
  const cached = api.getCached<{ data: Node[] }>("nodes:list:default");
  return mapNodeOptions(cached?.data ?? []);
}

const NO_SCOPES: string[] = [];

/** Which ingress targets an app environment offers, under the field. */
function appTargetsHint(environment: { name: string }, nodeCount: number, groupCount: number) {
  if (groupCount === 0) return allowedNodesHint(environment, nodeCount, "nginx");
  if (nodeCount === 0 && groupCount === 1) {
    return `The only ingress group allowed in ${environment.name}.`;
  }
  return `Only the nginx nodes and ingress groups allowed in ${environment.name} are offered.`;
}
const ROOT_FOLDER_VALUE = "__root__";

const STEP_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

export function defaultProxyUpstreamForDockerTargets(
  targets: DockerContainer[]
): ProxyUpstreamSelection {
  const firstTarget = targets[0];
  if (!firstTarget) return DEFAULT_PROXY_UPSTREAM;
  return {
    ...DEFAULT_PROXY_UPSTREAM,
    kind: firstTarget.kind === "deployment" ? "docker_deployment" : "docker_container",
  };
}

export function CreateProxyHostDialog({
  open,
  onOpenChange,
  existingHost,
  initialDomainName,
  initialNodeId,
  initialIngressGroupId,
  initialUpstream,
  onSuccess,
  appContext: appContextProp,
}: CreateProxyHostDialogProps) {
  const isEditing = !!existingHost;
  const appContext = isEditing ? undefined : appContextProp;
  const appEnvironment = useAppEnvironmentChoice(appContext, open);
  const environment = appEnvironment.environment;
  const hasScope = useAuthStore((state) => state.hasScope);
  const scopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  // Raw mode is toggled under proxy:raw:write (it seeds and then serves the raw config).
  const canToggleRawConfig = !!existingHost && hasScope(`proxy:raw:write:${existingHost.id}`);
  const maintenanceLocked = !!existingHost?.maintenanceEnabled;

  // Step navigation
  const [step, setStep] = useState(1);

  // Step 1 — Basics
  const [type, setType] = useState<ProxyHostType>("proxy");
  const [nodeId, setNodeId] = useState<string>("");
  const [autoNode, setAutoNode] = useState(false);
  const [ingressGroupId, setIngressGroupId] = useState("");
  const [ingressGroups, setIngressGroups] = useState<RouteIngressGroupOption[]>([]);
  const [ingressGroupsLoaded, setIngressGroupsLoaded] = useState(false);
  const [domainNames, setDomainNames] = useState<string[]>([""]);
  // Create only: destination folder ("" = root). Moving an existing route uses the move dialog.
  const [folderId, setFolderId] = useState<string>("");
  const [folderOptions, setFolderOptions] = useState<CreationFolderOption[]>([]);
  // Loads started when the dialog opens. Each flag is true from the first open
  // render and reset when the dialog closes, so the dialog opens at full size.
  const [foldersLoading, setFoldersLoading] = useState(true);

  // Step 2 — Configuration: Proxy
  const [upstream, setUpstream] = useState<ProxyUpstreamSelection>(DEFAULT_PROXY_UPSTREAM);
  const upstreamTouchedRef = useRef(false);
  const [websocketSupport, setWebsocketSupport] = useState(false);

  // Step 2 — Configuration: Redirect
  const [redirectUrl, setRedirectUrl] = useState("");
  const [redirectStatusCode, setRedirectStatusCode] = useState(301);

  // Step 2 — SSL
  const [sslEnabled, setSslEnabled] = useState(false);
  const [sslForced, setSslForced] = useState(false);
  const [http2Support, setHttp2Support] = useState(false);
  const [sslCertificateId, setSslCertificateId] = useState("");
  const [internalCertificateId, setInternalCertificateId] = useState("");

  // Step 2 — Template
  const [nginxTemplateId, setNginxTemplateId] = useState("");
  const [templateVariables, setTemplateVariables] = useState<
    Record<string, string | number | boolean>
  >({});

  // Raw config mode (edit only)
  const [rawConfigEnabled, setRawConfigEnabled] = useState(false);

  // Saving state
  const [isSaving, setIsSaving] = useState(false);

  // Related data (fetched on open)
  const [nodes, setNodes] = useState<NodeOption[]>(getCachedNodeOptions);
  const [nodesLoading, setNodesLoading] = useState(nodes.length === 0);
  const [sslCerts, setSslCerts] = useState<SSLCertificate[]>([]);
  const [sslCertsError, setSslCertsError] = useState<string | null>(null);
  const [nginxTemplateList, setNginxTemplateList] = useState<NginxTemplate[]>([]);
  const [supportLoading, setSupportLoading] = useState(true);
  const [dockerContainers, setDockerContainers] = useState<DockerContainer[]>([]);
  const [containersLoading, setContainersLoading] = useState(true);

  // Reset entire form to defaults
  const resetForm = useCallback(() => {
    setStep(1);

    setType("proxy");
    setNodeId("");
    setAutoNode(false);
    setIngressGroupId("");
    setFolderId("");
    setDomainNames([""]);
    setUpstream(DEFAULT_PROXY_UPSTREAM);
    upstreamTouchedRef.current = false;
    setWebsocketSupport(false);
    setRedirectUrl("");
    setRedirectStatusCode(301);
    setSslEnabled(false);
    setSslForced(false);
    setHttp2Support(false);
    setSslCertificateId("");
    setInternalCertificateId("");
    setNginxTemplateId("");
    setTemplateVariables({});
    setRawConfigEnabled(false);
    setIsSaving(false);
    setDockerContainers([]);
  }, []);

  // Pre-fill from existingHost every time the dialog opens for editing. The
  // close animation resets the form, so keying only on existingHost would leave
  // a blank form (and a destructive save) the second time the same host is edited.
  useEffect(() => {
    if (!open || !existingHost) return;
    setType(existingHost.type);
    setNodeId((existingHost as any).nodeId || "");
    setIngressGroupId(existingHost.ingressGroupId || "");
    setDomainNames(existingHost.domainNames.length > 0 ? [...existingHost.domainNames] : [""]);
    setUpstream(proxyUpstreamFromHost(existingHost));
    upstreamTouchedRef.current = false;
    setWebsocketSupport(existingHost.websocketSupport);
    setRedirectUrl(existingHost.redirectUrl || "");
    setRedirectStatusCode(existingHost.redirectStatusCode || 301);
    setSslEnabled(existingHost.sslEnabled);
    setSslForced(existingHost.sslForced);
    setHttp2Support(existingHost.http2Support);
    setSslCertificateId(existingHost.sslCertificateId || "");
    setInternalCertificateId(existingHost.internalCertificateId || "");
    setNginxTemplateId(existingHost.nginxTemplateId || "");
    setTemplateVariables(existingHost.templateVariables || {});
    setRawConfigEnabled(existingHost.rawConfigEnabled ?? false);
    setStep(1);
  }, [existingHost, open]);

  useEffect(() => {
    if (!open || existingHost) return;
    setNodeId(initialNodeId ?? "");
    setIngressGroupId(initialIngressGroupId ?? "");
    setDomainNames(initialDomainName ? [initialDomainName] : [""]);
    if (initialUpstream) {
      setType("proxy");
      setUpstream(initialUpstream);
      upstreamTouchedRef.current = true;
    }
  }, [
    existingHost,
    initialDomainName,
    initialIngressGroupId,
    initialNodeId,
    initialUpstream,
    open,
  ]);

  useLayoutEffect(() => {
    if (!open) return;
    const cachedNodes = getCachedNodeOptions();
    if (cachedNodes.length > 0) {
      setNodes(cachedNodes);
      setNodesLoading(false);
    } else if (nodes.length === 0) {
      setNodesLoading(true);
    }
  }, [nodes.length, open]);

  // Ingress groups a new route may use (every member open to the caller's grant).
  useEffect(() => {
    if (!open || existingHost) return;
    // Placing a route on a group needs multi-node availability; without it only nodes are offered.
    if (!planIncludes("multi-node-availability")) {
      setIngressGroups([]);
      setIngressGroupsLoaded(true);
      return;
    }
    let cancelled = false;
    void api
      .listRouteIngressGroups()
      .then((groups) => {
        if (!cancelled) setIngressGroups(groups);
      })
      .catch(() => {
        if (!cancelled) setIngressGroups([]);
      })
      .finally(() => {
        if (!cancelled) setIngressGroupsLoaded(true);
      });
    return () => {
      cancelled = true;
      setIngressGroupsLoaded(false);
    };
  }, [existingHost, open]);

  // Fetch related data when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void api
      .listNodes({ type: "nginx" })
      .then((response) => {
        if (!cancelled) setNodes(mapNodeOptions(response.data ?? []));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setNodesLoading(false);
      });

    // Certificates and Nginx templates need different permissions: one refused list must not
    // empty the other.
    const certificates = api
      .listSSLCertificates({ limit: 100 })
      .then((response) => {
        if (cancelled) return;
        setSslCerts(response.data || []);
        setSslCertsError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSslCerts([]);
        setSslCertsError(pickerLoadError(error, "certificates"));
      });
    // Without templates the Route uses the default template; the picker is simply not offered.
    const templates = api
      .listNginxTemplates()
      .then((response) => {
        if (!cancelled) setNginxTemplateList(response || []);
      })
      .catch(() => {
        if (!cancelled) setNginxTemplateList([]);
      });
    void Promise.allSettled([certificates, templates]).then(() => {
      if (!cancelled) setSupportLoading(false);
    });
    void api
      .listDockerContainerSnapshots()
      .then((containers) => {
        if (!cancelled) setDockerContainers(containers);
      })
      .catch(() => {
        if (!cancelled) setDockerContainers([]);
      })
      .finally(() => {
        if (!cancelled) setContainersLoading(false);
      });
    return () => {
      cancelled = true;
      setSupportLoading(true);
      setContainersLoading(true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || isEditing) return;
    let cancelled = false;
    void api
      .listFolders()
      .then((tree) => {
        if (!cancelled) setFolderOptions(flattenCreationFolders(tree ?? []));
      })
      .catch(() => {
        if (!cancelled) setFolderOptions([]);
      })
      .finally(() => {
        if (!cancelled) setFoldersLoading(false);
      });
    return () => {
      cancelled = true;
      setFoldersLoading(true);
    };
  }, [isEditing, open]);

  useEffect(() => {
    if (!open || isEditing || type !== "proxy" || upstreamTouchedRef.current) return;
    setUpstream(defaultProxyUpstreamForDockerTargets(dockerContainers));
  }, [dockerContainers, isEditing, open, type]);

  // Derived: user templates matching current type
  const userTemplates = useMemo(
    () =>
      nginxTemplateList.filter(
        (template) =>
          !template.isBuiltin &&
          template.type === type &&
          (upstream.kind !== "pages" || supportsPagesRouteTemplate(template.content))
      ),
    [nginxTemplateList, type, upstream.kind]
  );

  useEffect(() => {
    if (upstream.kind !== "pages" || !nginxTemplateId) return;
    const selected = nginxTemplateList.find((template) => template.id === nginxTemplateId);
    if (!selected || !supportsPagesRouteTemplate(selected.content)) setNginxTemplateId("");
  }, [nginxTemplateId, nginxTemplateList, upstream.kind]);

  // A folder grant allows creating on any ingress node; node grants only on their nodes.
  const hasFolderCreationGrant = useMemo(
    () => scopes.some((scope) => scope.startsWith("proxy:create:folder/")),
    [scopes]
  );
  const visibleNodes = useMemo(
    () =>
      isEditing
        ? nodes
        : nodes.filter(
            (node) =>
              hasFolderCreationGrant || canCreateInFolder(scopes, "proxy:create", null, node.id)
          ),
    [hasFolderCreationGrant, isEditing, nodes, scopes]
  );
  // From an app: the environment's allowed nginx nodes, and the ingress groups whose members are
  // all allowed (a group serves the route from every member).
  const targetNodes = useMemo(
    () => (appContext ? allowedAppNodes(environment, visibleNodes) : visibleNodes),
    [appContext, environment, visibleNodes]
  );
  const targetGroups = useMemo(() => {
    if (!appContext) return ingressGroups;
    const allowed = new Set(environment?.allowedNodeIds ?? []);
    return ingressGroups.filter(
      (group) => group.members.length > 0 && group.members.every((member) => allowed.has(member.id))
    );
  }, [appContext, environment, ingressGroups]);
  const appTargetCount = targetNodes.length + targetGroups.length;
  const appTargetLocked = !!appContext && appTargetCount === 1;
  const noAllowedNode =
    !!appContext && !!environment && !nodesLoading && ingressGroupsLoaded && appTargetCount === 0;
  const appTargetAllowed = useCallback(
    (target: IngressTarget) =>
      target.ingressGroupId
        ? targetGroups.some((group) => group.id === target.ingressGroupId)
        : targetNodes.some((node) => node.id === target.nodeId),
    [targetGroups, targetNodes]
  );
  const placementFolderId = appContext ? appPlacementFolderId(environment, "routes") : null;
  const folderChoices = useMemo(
    () => creationFolderChoices(scopes, "proxy:create", folderOptions, nodeId),
    [folderOptions, nodeId, scopes]
  );
  useEffect(() => {
    if (!open || isEditing || appContext) return;
    setFolderId((current) => allowedCreationFolderId(folderChoices, current));
  }, [appContext, folderChoices, isEditing, open]);
  const canCreateInSelectedFolder =
    isEditing ||
    canCreateInFolder(
      scopes,
      "proxy:create",
      (appContext ? placementFolderId : folderId) || null,
      nodeId || undefined
    );
  // A node-free destination check needs a broad or folder grant; node-only creators pick their node.
  // From an app the target is always one of the environment's allowed ones.
  const canUseAutomaticNode =
    !isEditing &&
    !appContext &&
    (canCreateInFolder(scopes, "proxy:create", null) || hasFolderCreationGrant);
  const chooseTarget = (target: IngressTarget) => {
    setAutoNode(target.auto);
    setNodeId(target.nodeId);
    setIngressGroupId(target.ingressGroupId);
  };
  const showFolderPicker =
    !isEditing && (!!appContext || folderChoices.folders.length > 0 || !folderChoices.allowRoot);

  // From an app: the only allowed target is the destination; a target the environment does not
  // allow is dropped when the environment changes.
  useEffect(() => {
    if (!open || !appContext || nodesLoading || !ingressGroupsLoaded) return;
    const current = { nodeId, ingressGroupId, auto: autoNode };
    if (appTargetLocked) {
      const onlyGroup = targetGroups[0];
      const next = onlyGroup
        ? { nodeId: "", ingressGroupId: onlyGroup.id, auto: false }
        : { nodeId: targetNodes[0]!.id, ingressGroupId: "", auto: false };
      if (next.nodeId !== nodeId || next.ingressGroupId !== ingressGroupId || autoNode) {
        setAutoNode(false);
        setNodeId(next.nodeId);
        setIngressGroupId(next.ingressGroupId);
      }
    } else if ((nodeId || ingressGroupId || autoNode) && !appTargetAllowed(current)) {
      setAutoNode(false);
      setNodeId("");
      setIngressGroupId("");
    }
  }, [
    appContext,
    appTargetAllowed,
    appTargetLocked,
    autoNode,
    ingressGroupId,
    ingressGroupsLoaded,
    nodeId,
    nodesLoading,
    open,
    targetGroups,
    targetNodes,
  ]);
  const selectedNode = useMemo(
    () => visibleNodes.find((node) => node.id === nodeId) ?? null,
    [nodeId, visibleNodes]
  );
  const selectedLockedForCreation =
    !!selectedNode?.serviceCreationLocked &&
    (!isEditing || selectedNode.id !== (existingHost as any)?.nodeId);

  // Editing touches only the entrypoint, so it waits for the node list alone.
  const optionsLoading =
    nodesLoading || (!isEditing && (foldersLoading || supportLoading || containersLoading));

  // Validation
  const isStep1Valid =
    (nodeId !== "" || ingressGroupId !== "" || (autoNode && canUseAutomaticNode)) &&
    !noAllowedNode &&
    (!appContext || appTargetAllowed({ nodeId, ingressGroupId, auto: autoNode })) &&
    !selectedLockedForCreation &&
    canCreateInSelectedFolder &&
    domainNames.some((d) => d.trim() !== "");

  const isStep2Valid = (() => {
    if (type === "proxy" && !isProxyUpstreamValid(upstream)) return false;
    if (type === "redirect" && !redirectUrl.trim()) return false;
    if (sslEnabled && !sslCertificateId) return false;
    return true;
  })();

  // Navigation
  const goNext = () => setStep(2);
  const goBack = () => setStep(1);

  // Handle close
  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
  };

  // Build the edit payload. The dialog only edits the entrypoint (type, node,
  // domains, raw mode), so it sends only those fields: echoing TLS, template or
  // raw settings would overwrite them or require unrelated scopes.
  const buildUpdateRequest = (host: ProxyHost): Partial<CreateProxyHostRequest> => {
    const req: Partial<CreateProxyHostRequest> = {
      type,
      // A route on an ingress group changes its placement from the route page, not here.
      ...(host.ingressGroupId ? {} : { nodeId }),
      domainNames: domainNames.filter((d) => d.trim() !== ""),
    };
    if (rawConfigEnabled !== (host.rawConfigEnabled ?? false)) {
      req.rawConfigEnabled = rawConfigEnabled;
    }
    if (type === "proxy" && host.type !== "proxy") {
      Object.assign(req, proxyUpstreamRequest(upstream));
    }
    if (type === "redirect" && redirectUrl.trim()) {
      req.redirectUrl = redirectUrl;
      req.redirectStatusCode = redirectStatusCode;
    }
    return req;
  };

  // Build request payload
  const buildRequest = (): CreateProxyHostRequest => {
    const domains = domainNames.filter((d) => d.trim() !== "");
    const req: CreateProxyHostRequest = {
      type,
      nodeId: autoNode || ingressGroupId ? undefined : nodeId,
      ...(ingressGroupId ? { ingressGroupId } : {}),
      domainNames: domains,
      folderId: (appContext ? placementFolderId : folderId) || undefined,
      websocketSupport: upstream.kind === "pages" ? false : websocketSupport,
      sslEnabled,
      sslForced,
      http2Support,
      sslCertificateId: sslCertificateId || undefined,
      internalCertificateId: internalCertificateId || undefined,
      nginxTemplateId: nginxTemplateId || undefined,
      templateVariables: Object.keys(templateVariables).length > 0 ? templateVariables : undefined,
      healthCheckEnabled: false,
    };

    if (type === "proxy") {
      Object.assign(req, proxyUpstreamRequest(upstream));
    }
    if (type === "redirect") {
      req.redirectUrl = redirectUrl;
      req.redirectStatusCode = redirectStatusCode;
    }

    return req;
  };

  // Save handler
  const handleSave = async () => {
    if (!isEditing && !isStep2Valid) return;

    setIsSaving(true);
    try {
      const data = isEditing && existingHost ? buildUpdateRequest(existingHost) : buildRequest();

      // When enabling raw mode: seed rawConfig, set type to raw, disable healthcheck
      if (isEditing && existingHost && rawConfigEnabled && !existingHost.rawConfigEnabled) {
        try {
          const rendered = await api.getRenderedProxyConfig(existingHost.id);
          data.rawConfig = rendered.rendered;
        } catch {
          // If we can't fetch rendered config, proceed without seeding
        }
        data.type = "raw";
        data.healthCheckEnabled = false;
      }

      // When disabling raw mode: restore original type
      if (isEditing && existingHost && !rawConfigEnabled && existingHost.rawConfigEnabled) {
        // Type stays as whatever user had before (stored in the data from step 1)
        // but if it's still "raw", reset to proxy
        if (data.type === "raw") {
          data.type = "proxy";
          Object.assign(data, proxyUpstreamRequest(upstream));
        }
      }

      if (isEditing && existingHost) {
        const updated = await api.updateProxyHost(existingHost.id, data);
        toast.success("Route updated");
        onSuccess?.(existingHost.id, updated);
      } else {
        const created = await api.createProxyHost(data as CreateProxyHostRequest);
        toast.success("Route created");
        rememberAppCreation(appContext, environment);
        onSuccess?.(created.id, created);
      }
      onOpenChange(false);
    } catch (err) {
      toastApiError(err, "Failed to save route");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            resetForm();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Route" : "Create Route"}</DialogTitle>
          <DialogDescription>
            {step === 1
              ? "Configure the entrypoint for this route."
              : "Configure the target and TLS for this route."}
          </DialogDescription>
        </DialogHeader>

        <AnimatedHeight>
          <ContentLoading loading={optionsLoading} />
          <AnimatePresence initial={false} mode="popLayout">
            {step === 1 && (
              <motion.div
                key="step-1"
                initial={STEP_ANIMATION.initial}
                animate={STEP_ANIMATION.animate}
                exit={STEP_ANIMATION.exit}
                transition={STEP_ANIMATION.transition}
                className="space-y-6"
              >
                {appContext && (
                  <AppEnvironmentFields
                    context={appContext}
                    environmentId={appEnvironment.environmentId}
                    onEnvironmentChange={appEnvironment.setEnvironmentId}
                  />
                )}
                {noAllowedNode && appContext && environment ? (
                  <NoAllowedNodeNotice
                    context={appContext}
                    environment={environment}
                    nodeKind="nginx"
                    resourceKind="Routes"
                    onNavigate={() => handleOpenChange(false)}
                  />
                ) : (
                  <>
                    {/* Type Selector */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Type</label>
                      <Select
                        value={rawConfigEnabled ? "raw" : type}
                        onValueChange={(v) => setType(v as ProxyHostType)}
                        disabled={rawConfigEnabled || maintenanceLocked}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {rawConfigEnabled && <SelectItem value="raw">Raw</SelectItem>}
                          <SelectItem value="proxy">Proxy</SelectItem>
                          <SelectItem value="redirect">Redirect</SelectItem>
                          <SelectItem value="404">404</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Node or ingress group */}
                    <IngressTargetSelect
                      target={{ nodeId, ingressGroupId, auto: autoNode }}
                      onChange={chooseTarget}
                      nodes={targetNodes}
                      groups={targetGroups}
                      loading={nodesLoading}
                      allowAutomatic={canUseAutomaticNode}
                      disabled={appTargetLocked}
                      hint={
                        appContext && environment && appTargetCount > 0
                          ? appTargetsHint(environment, targetNodes.length, targetGroups.length)
                          : null
                      }
                      currentNodeId={isEditing ? ((existingHost as any)?.nodeId ?? null) : null}
                      lockedGroupName={
                        isEditing && existingHost?.ingressGroupId
                          ? (existingHost.ingressGroup?.name ?? "Ingress group")
                          : null
                      }
                    />

                    {showFolderPicker && (
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Folder</label>
                        <Select
                          value={
                            appContext
                              ? ROOT_FOLDER_VALUE
                              : folderId || (folderChoices.allowRoot ? ROOT_FOLDER_VALUE : "")
                          }
                          onValueChange={(value) =>
                            setFolderId(value === ROOT_FOLDER_VALUE ? "" : value)
                          }
                        >
                          <SelectTrigger aria-label="Folder">
                            <SelectValue placeholder="Select a folder..." />
                          </SelectTrigger>
                          <SelectContent>
                            {(appContext || folderChoices.allowRoot) && (
                              <SelectItem value={ROOT_FOLDER_VALUE}>No folder</SelectItem>
                            )}
                            {(appContext ? [] : folderChoices.folders).map((folder) => (
                              <SelectItem key={folder.id} value={folder.id}>
                                {"  ".repeat(folder.depth) + folder.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Domain Names */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Domain Names</label>
                      <div className="space-y-2">
                        <AnimatePresence initial={false}>
                          {domainNames.map((domain, i) => (
                            <motion.div
                              key={`domain-${i}`}
                              initial={{ opacity: 0, y: 4 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: 4 }}
                              transition={{
                                opacity: { duration: 0.12 },
                                y: { duration: 0.12, ease: [0.25, 0.1, 0.25, 1] },
                              }}
                              className="flex border border-input bg-background"
                            >
                              <DomainAutocompleteInput
                                value={domain}
                                nginxNodeId={nodeId || undefined}
                                onChange={(v) => {
                                  const next = [...domainNames];
                                  next[i] = v;
                                  setDomainNames(next);
                                }}
                                onDomainSelect={(selectedDomain) => {
                                  // From an app, a domain's node or group is taken only when the
                                  // environment allows it.
                                  if (
                                    appContext &&
                                    !appTargetAllowed({
                                      nodeId: selectedDomain?.nginxNodeId ?? "",
                                      ingressGroupId: selectedDomain?.ingressGroupId ?? "",
                                      auto: false,
                                    })
                                  ) {
                                    return;
                                  }
                                  if (selectedDomain?.ingressGroupId && !isEditing) {
                                    chooseTarget({
                                      nodeId: "",
                                      ingressGroupId: selectedDomain.ingressGroupId,
                                      auto: false,
                                    });
                                  } else if (selectedDomain?.nginxNodeId && !ingressGroupId) {
                                    setAutoNode(false);
                                    setNodeId(selectedDomain.nginxNodeId);
                                  }
                                }}
                                placeholder="example.com"
                                inputClassName="border-0 shadow-none"
                              />
                              {domainNames.length > 1 && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="rounded-none border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                                  aria-label={`Remove domain ${i + 1}`}
                                  onClick={() =>
                                    setDomainNames(domainNames.filter((_, j) => j !== i))
                                  }
                                >
                                  <Minus className="h-4 w-4" />
                                </Button>
                              )}
                              {i === domainNames.length - 1 && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="rounded-none border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                                  aria-label="Add domain"
                                  onClick={() => setDomainNames([...domainNames, ""])}
                                >
                                  <Plus className="h-4 w-4" />
                                </Button>
                              )}
                            </motion.div>
                          ))}
                        </AnimatePresence>
                      </div>
                    </div>

                    {/* Raw mode toggle — only when editing with the raw toggle scope */}
                    {isEditing && canToggleRawConfig && (
                      <SwitchCard
                        label="Raw Config Mode"
                        description="Bypass template rendering and edit nginx config directly"
                        checked={rawConfigEnabled}
                        onCheckedChange={setRawConfigEnabled}
                        disabled={maintenanceLocked}
                      />
                    )}
                  </>
                )}
              </motion.div>
            )}

            {step === 2 && !isEditing && (
              <motion.div
                key="step-2"
                initial={STEP_ANIMATION.initial}
                animate={STEP_ANIMATION.animate}
                exit={STEP_ANIMATION.exit}
                transition={STEP_ANIMATION.transition}
                className="space-y-4"
              >
                {/* Forwarding / Redirect card */}
                {type === "proxy" && (
                  <PanelShell title="Forwarding">
                    <ProxyUpstreamFields
                      value={upstream}
                      onChange={(value) => {
                        upstreamTouchedRef.current = true;
                        setUpstream(value);
                      }}
                      containers={dockerContainers}
                    />
                  </PanelShell>
                )}

                {type === "redirect" && (
                  <PanelShell title="Redirect">
                    <SettingsControlRow
                      title="Redirect URL"
                      description="Target URL for incoming requests"
                      controlsClassName="sm:w-full"
                    >
                      <Input
                        value={redirectUrl}
                        onChange={(e) => setRedirectUrl(e.target.value)}
                        placeholder="https://example.com"
                        aria-label="Redirect URL"
                      />
                    </SettingsControlRow>
                    <SettingsControlRow
                      title="Status Code"
                      description="HTTP redirect response status"
                      controlsClassName="sm:w-full"
                    >
                      <Select
                        value={String(redirectStatusCode)}
                        onValueChange={(v) => setRedirectStatusCode(Number(v))}
                      >
                        <SelectTrigger aria-label="Redirect status code">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {REDIRECT_STATUS_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={String(option.value)}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </SettingsControlRow>
                  </PanelShell>
                )}

                {/* SSL card — always visible, inner controls disabled when SSL off */}
                <div className="border border-border bg-card">
                  {type === "proxy" && upstream.kind !== "pages" && (
                    <SettingsControlRow
                      title="WebSocket Support"
                      description="Enable WebSocket proxying"
                    >
                      <Switch checked={websocketSupport} onChange={setWebsocketSupport} />
                    </SettingsControlRow>
                  )}
                  {userTemplates.length > 0 && (
                    <SettingsControlRow
                      title="Config Template"
                      description="Nginx configuration template"
                    >
                      <Select
                        value={nginxTemplateId || "__none__"}
                        onValueChange={(v) => {
                          const newId = v === "__none__" ? "" : v;
                          setNginxTemplateId(newId);
                          if (newId) {
                            const tmpl = nginxTemplateList.find((t) => t.id === newId);
                            if (tmpl?.variables?.length) {
                              const defaults: Record<string, string | number | boolean> = {};
                              for (const vd of tmpl.variables) {
                                if (vd.default !== undefined) defaults[vd.name] = vd.default;
                              }
                              setTemplateVariables((prev) => ({ ...defaults, ...prev }));
                            }
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Default template" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Default template</SelectItem>
                          {userTemplates.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </SettingsControlRow>
                  )}
                  <SettingsControlRow title="SSL Enabled" description="Serve this host over HTTPS">
                    <Switch checked={sslEnabled} onChange={setSslEnabled} />
                  </SettingsControlRow>
                  <SettingsControlRow title="Force HTTPS" description="Redirect HTTP to HTTPS">
                    <div className={cn(!sslEnabled && "opacity-50")}>
                      <Switch checked={sslForced} onChange={setSslForced} disabled={!sslEnabled} />
                    </div>
                  </SettingsControlRow>
                  <SettingsControlRow title="HTTP/2" description="Enable HTTP/2 protocol support">
                    <div className={cn(!sslEnabled && "opacity-50")}>
                      <Switch
                        checked={http2Support}
                        onChange={setHttp2Support}
                        disabled={!sslEnabled}
                      />
                    </div>
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="SSL Certificate"
                    description={sslCertsError ?? undefined}
                  >
                    <div className={cn("w-full", !sslEnabled && "pointer-events-none opacity-50")}>
                      <Combobox
                        value={sslCertificateId}
                        options={[
                          { value: "", label: "None" },
                          ...sslCerts.map((certificate) => ({
                            value: certificate.id,
                            label: `${certificate.name} (${certificate.type})`,
                            keywords: certificate.domainNames?.join(" ") ?? "",
                          })),
                        ]}
                        onValueChange={setSslCertificateId}
                        placeholder="Select certificate..."
                        searchPlaceholder="Search certificates..."
                        emptyMessage={sslCertsError ?? "No matching certificates."}
                        ariaLabel="SSL Certificate"
                        disabled={!sslEnabled}
                      />
                    </div>
                  </SettingsControlRow>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </AnimatedHeight>

        <DialogFooter>
          {isEditing ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={!isStep1Valid} pending={isSaving}>
                Save
              </Button>
            </>
          ) : step === 1 ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={goNext} disabled={!isStep1Valid}>
                Next
                <ArrowRight className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={goBack}>
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button onClick={handleSave} disabled={!isStep2Valid} pending={isSaving}>
                Create
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
