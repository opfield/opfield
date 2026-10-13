import { KeyRound, Pencil, Pin, RefreshCw, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { AppMembershipLink } from "@/components/apps/AppMembership";
import { MemberIsolatedNotice, useMemberIncidentHold } from "@/components/apps/IsolatedNotice";
import { confirm, confirmAction } from "@/components/common/ConfirmDialog";
import { CopyButton } from "@/components/common/CopyButton";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { Notice } from "@/components/common/Notice";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SwitchCard } from "@/components/common/SwitchCard";
import { CreateProxyHostDialog } from "@/components/proxy/CreateProxyHostDialog";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HealthBars } from "@/components/ui/health-bars";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { toastApiError } from "@/lib/api-error-toast";
import { isOpfieldPublicRoute } from "@/lib/proxy-route-protection";
import { proxyHostRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { useFolderStore } from "@/stores/folders";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type {
  AccessList,
  CustomHeader,
  ForwardScheme,
  NginxTemplate,
  ProxyHost,
  RewriteRule,
  SSLCertificate,
} from "@/types";
import { AdvancedTab } from "./proxy-detail/AdvancedTab";
import { DetailsTab } from "./proxy-detail/DetailsTab";
import {
  effectiveHealthStatus,
  HEALTH_BADGE,
  HEALTH_LABEL,
  TYPE_BADGE,
} from "./proxy-detail/helpers";
import { LogsTab } from "./proxy-detail/LogsTab";
import { saveProxyHostAccessList, saveProxyHostAdvancedConfig } from "./proxy-detail/mutations";
import { RawConfigTab } from "./proxy-detail/RawConfigTab";
import { SecureLinkTab } from "./proxy-detail/SecureLinkTab";
import { SettingsTab } from "./proxy-detail/SettingsTab";
import { deriveProxyHostDetailFormState } from "./proxy-detail/state";

type ProxyHostDraftSection =
  | "template"
  | "headers"
  | "rewrites"
  | "ssl"
  | "health"
  | "advanced"
  | "raw";

type ProxyHostDraftState = Record<ProxyHostDraftSection, boolean>;

const CLEAN_PROXY_HOST_DRAFTS: ProxyHostDraftState = {
  template: false,
  headers: false,
  rewrites: false,
  ssl: false,
  health: false,
  advanced: false,
  raw: false,
};

interface SyncHostStateOptions {
  preserveDirty?: boolean;
  forceSections?: ProxyHostDraftSection[];
}

// ── Main Component ──────────────────────────────────────────────
export function ProxyHostDetail({
  resolvedProxyHostId,
  resolvedProxySlug,
}: {
  resolvedProxyHostId?: string;
  resolvedProxySlug?: string;
} = {}) {
  const params = useParams<{ id?: string; proxySlug?: string; tab?: string }>();
  const id = resolvedProxyHostId ?? params.id;
  const routeSlug = resolvedProxySlug ?? params.proxySlug ?? params.id ?? "";
  const navigate = useStableNavigate();
  const { hasScope } = useAuthStore();
  const opfieldPublicUrl = useUIBootstrapStore(
    (state) => state.snapshot?.systemConfig.publicUrl ?? null
  );
  const canViewAdvancedConfig = !!id && hasScope(`proxy:advanced:${id}`);
  const canViewRawConfig = !!id && hasScope(`proxy:raw:read:${id}`);
  const canWriteRawConfig = !!id && hasScope(`proxy:raw:write:${id}`);
  const canEditProxyHost = !!id && (hasScope("proxy:edit") || hasScope(`proxy:edit:${id}`));
  const canDeleteProxyHost = !!id && (hasScope("proxy:delete") || hasScope(`proxy:delete:${id}`));
  const [host, setHost] = useState<ProxyHost | null>(null);
  // The open incident of the route's app environment refuses deleting it and its Secure Link bindings.
  const {
    app: memberApp,
    reload: reloadMemberApp,
    hold: incidentHold,
  } = useMemberIncidentHold(host?.app);
  const [maintenanceAccessCode, setMaintenanceAccessCode] = useState<string | null>(null);
  const displayedMaintenanceAccessCode = useRetainedDialogValue(
    maintenanceAccessCode,
    maintenanceAccessCode !== null
  );
  const [isCreatingMaintenanceAccessCode, setIsCreatingMaintenanceAccessCode] = useState(false);
  const hasSecureLinkRuntime =
    host?.type === "proxy" &&
    host.secureLinkActive === true &&
    (host.upstreamKind === "docker_container" || host.upstreamKind === "docker_deployment");
  const visibleTabs = useMemo(
    () => [
      "details",
      "settings",
      ...(hasSecureLinkRuntime ? ["secure-link"] : []),
      ...(canViewAdvancedConfig ? ["advanced"] : []),
      ...(canViewRawConfig ? ["raw"] : []),
      "logs",
    ],
    [canViewAdvancedConfig, canViewRawConfig, hasSecureLinkRuntime]
  );

  const [healthHistory, setHealthHistory] = useState<NonNullable<ProxyHost["healthHistory"]>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMaintenanceToggling, setIsMaintenanceToggling] = useState(false);
  const [isTlsResyncing, setIsTlsResyncing] = useState(false);

  const [activeTab, setActiveTab] = useUrlTab(visibleTabs, "details", (tab) =>
    proxyHostRoute(routeSlug, tab)
  );

  useEffect(() => {
    if (params.tab === "secure-link" && host && !hasSecureLinkRuntime) {
      setActiveTab("details");
    }
  }, [hasSecureLinkRuntime, host, params.tab, setActiveTab]);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);

  // Pin dialog
  const [pinOpen, setPinOpen] = useState(false);
  const { isPinnedDashboard, isPinnedSidebar, toggleDashboard, toggleSidebar } =
    usePinnedProxiesStore();

  // Custom config tab state
  const [customHeaders, setCustomHeaders] = useState<CustomHeader[]>([]);
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [cacheMaxAge, setCacheMaxAge] = useState(3600);
  const [rateLimitMode, setRateLimitMode] = useState<"inherit" | "custom" | "disabled">("inherit");
  const [rateLimitRPS, setRateLimitRPS] = useState(1000);
  const [rateLimitBurst, setRateLimitBurst] = useState(3000);
  const [rateLimitConnectionsPerIp, setRateLimitConnectionsPerIp] = useState(1000);
  const [customRewrites, setCustomRewrites] = useState<RewriteRule[]>([]);
  const [isSavingCustom, setIsSavingCustom] = useState(false);
  const [editorErrorLines, setEditorErrorLines] = useState<number[]>([]);

  // Health check settings state
  const [healthCheckUrl, setHealthCheckUrl] = useState("/");
  const [healthCheckEnabled, setHealthCheckEnabled] = useState(false);
  const [healthCheckExpectedStatus, setHealthCheckExpectedStatus] = useState<number | null>(null);
  const [healthCheckExpectedBody, setHealthCheckExpectedBody] = useState("");
  const [healthCheckBodyMatchMode, setHealthCheckBodyMatchMode] = useState<
    "includes" | "exact" | "starts_with" | "ends_with"
  >("includes");
  const [healthCheckSlowThreshold, setHealthCheckSlowThreshold] = useState(3);
  const [isSavingHealthCheck, setIsSavingHealthCheck] = useState(false);
  const [sslEnabled, setSslEnabled] = useState(false);
  const [sslForced, setSslForced] = useState(false);
  const [http2Support, setHttp2Support] = useState(false);
  const [sslCertificateId, setSslCertificateId] = useState("");
  const [isSavingSsl, setIsSavingSsl] = useState(false);
  // Access list tab state
  const [accessListId, setAccessListId] = useState<string>("");
  const [accessLists, setAccessLists] = useState<AccessList[]>([]);
  const [sslCerts, setSslCerts] = useState<SSLCertificate[]>([]);
  const [nginxTemplates, setNginxTemplates] = useState<NginxTemplate[]>([]);
  const [nginxTemplateId, setNginxTemplateId] = useState<string>("");
  const [templateVariables, setTemplateVariables] = useState<
    Record<string, string | number | boolean>
  >({});
  const [templateForwardScheme, setTemplateForwardScheme] = useState<ForwardScheme>("http");
  const [templateForwardHost, setTemplateForwardHost] = useState("");
  const [templateForwardPort, setTemplateForwardPort] = useState(80);
  const [templateRedirectUrl, setTemplateRedirectUrl] = useState("");
  const [templateRedirectStatusCode, setTemplateRedirectStatusCode] = useState(301);
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);

  // Advanced tab state
  const [advancedConfig, setAdvancedConfig] = useState("");
  const [isSavingAdvanced, setIsSavingAdvanced] = useState(false);

  // Raw config tab state
  const [renderedConfig, setRenderedConfig] = useState("");
  const [rawConfig, setRawConfig] = useState("");
  const [isLoadingRaw, setIsLoadingRaw] = useState(false);
  const [hasLoadedRendered, setHasLoadedRendered] = useState(false);
  const renderedRequest = useRef(0);
  const renderedResource = useRef(id);
  const renderedValue = useRef("");
  useEffect(() => {
    renderedResource.current = id;
    renderedRequest.current++;
    renderedValue.current = "";
    setRenderedConfig("");
    setHasLoadedRendered(false);
    return () => {
      renderedRequest.current++;
    };
  }, [id]);
  const [isSavingRaw, setIsSavingRaw] = useState(false);

  const dirtySectionsRef = useRef<ProxyHostDraftState>(CLEAN_PROXY_HOST_DRAFTS);

  const syncHostState = useCallback((data: ProxyHost, options: SyncHostStateOptions = {}) => {
    const nextState = deriveProxyHostDetailFormState(data);
    const preserveDirty = options.preserveDirty ?? true;
    const forcedSections = new Set(options.forceSections ?? []);
    const shouldHydrate = (section: ProxyHostDraftSection) =>
      !preserveDirty || forcedSections.has(section) || !dirtySectionsRef.current[section];

    setHost(data);
    if (shouldHydrate("headers")) setCustomHeaders(nextState.customHeaders);
    if (shouldHydrate("template")) {
      setCacheEnabled(nextState.cacheEnabled);
      setCacheMaxAge(nextState.cacheMaxAge);
      setRateLimitMode(nextState.rateLimitMode);
      setRateLimitRPS(nextState.rateLimitRPS);
      setRateLimitBurst(nextState.rateLimitBurst);
      setRateLimitConnectionsPerIp(nextState.rateLimitConnectionsPerIp);
      setNginxTemplateId(nextState.nginxTemplateId);
      setTemplateVariables(nextState.templateVariables);
      setTemplateForwardScheme(nextState.templateForwardScheme);
      setTemplateForwardHost(nextState.templateForwardHost);
      setTemplateForwardPort(nextState.templateForwardPort);
      setTemplateRedirectUrl(nextState.templateRedirectUrl);
      setTemplateRedirectStatusCode(nextState.templateRedirectStatusCode);
    }
    if (shouldHydrate("rewrites")) setCustomRewrites(nextState.customRewrites);
    setAccessListId(nextState.accessListId);
    if (shouldHydrate("health")) {
      setHealthCheckUrl(nextState.healthCheckUrl);
      setHealthCheckEnabled(data.healthCheckEnabled);
      setHealthCheckExpectedStatus(nextState.healthCheckExpectedStatus);
      setHealthCheckExpectedBody(nextState.healthCheckExpectedBody);
      setHealthCheckBodyMatchMode(nextState.healthCheckBodyMatchMode);
      setHealthCheckSlowThreshold(nextState.healthCheckSlowThreshold);
    }
    if (shouldHydrate("ssl")) {
      setSslEnabled(data.sslEnabled);
      setSslForced(data.sslForced);
      setHttp2Support(data.http2Support);
      setSslCertificateId(data.sslCertificateId || "");
    }
    if (shouldHydrate("advanced")) setAdvancedConfig(nextState.advancedConfig);
    if (shouldHydrate("raw")) setRawConfig(nextState.rawConfig);
  }, []);

  // ── Load host ─────────────────────────────────────────────────
  const loadHost = useCallback(
    async (silent = false) => {
      if (!id) return;
      if (!silent) setIsLoading(true);
      try {
        const data = await api.getProxyHost(id);
        const history = data.healthCheckEnabled ? await api.getProxyHostHealthHistory(id) : [];
        syncHostState(data, { preserveDirty: silent });
        setHealthHistory(history);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
          usePinnedProxiesStore.getState().removePin(id);
        }
        if (!silent) {
          toast.error("Failed to load route");
          navigate("/routes");
        }
      } finally {
        if (!silent) setIsLoading(false);
      }
    },
    [id, navigate, syncHostState]
  );

  useEffect(() => {
    loadHost();
  }, [loadHost]);

  useRealtime(id ? "proxy.host.changed" : null, (payload) => {
    const ev = payload as { id?: string; action?: string; oldSlug?: string; slug?: string };
    if (!ev || ev.id !== id) return;
    if (ev.oldSlug === routeSlug && ev.slug) {
      navigate(proxyHostRoute(ev.slug, activeTab), { replace: true });
      return;
    }
    if (ev.action === "deleted") {
      toast.info("Route was deleted");
      navigate("/routes");
      return;
    }
    loadHost(true);
  });

  useRealtime(id ? "ssl.cert.changed" : null, () => {
    loadHost(true);
  });

  useRealtime(id ? "cert.changed" : null, () => {
    loadHost(true);
  });

  // ── Load access lists ─────────────────────────────────────────
  // The Settings tab waits for these option lists on its first reveal.
  const [accessListsLoading, setAccessListsLoading] = useState(true);
  const [sslCertsLoading, setSslCertsLoading] = useState(true);
  const [nginxTemplatesLoading, setNginxTemplatesLoading] = useState(true);
  const loadAccessLists = useCallback(async () => {
    try {
      const res = await api.listAccessLists({ limit: 100 });
      setAccessLists(res.data || []);
    } catch {
    } finally {
      setAccessListsLoading(false);
    }
  }, []);

  const loadSSLCerts = useCallback(async () => {
    try {
      const res = await api.listSSLCertificates({ limit: 100 });
      setSslCerts(res.data || []);
    } catch {
    } finally {
      setSslCertsLoading(false);
    }
  }, []);

  const loadNginxTemplates = useCallback(async () => {
    try {
      const data = await api.listNginxTemplates();
      setNginxTemplates(data || []);
    } catch {
    } finally {
      setNginxTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccessLists();
  }, [loadAccessLists]);

  useEffect(() => {
    void loadSSLCerts();
  }, [loadSSLCerts]);

  useEffect(() => {
    void loadNginxTemplates();
  }, [loadNginxTemplates]);

  useRealtime("access-list.changed", () => {
    void loadAccessLists();
  });

  useRealtime("ssl.cert.changed", () => {
    void loadSSLCerts();
  });

  useRealtime("nginx.template.changed", () => {
    void loadNginxTemplates();
  });

  // ── Load rendered config ──────────────────────────────────────
  const loadRenderedConfig = useCallback(async () => {
    if (!id) return;
    const request = ++renderedRequest.current;
    setIsLoadingRaw(true);
    try {
      const result = await api.getRenderedProxyConfig(id);
      if (request !== renderedRequest.current || renderedResource.current !== id) return;
      renderedValue.current = result.rendered;
      setRenderedConfig(result.rendered);
    } catch {
      if (request !== renderedRequest.current) return;
      if (!renderedValue.current) setRenderedConfig("# Could not load rendered config.");
      else toast.error("Could not refresh rendered config. Showing the last loaded version.");
    } finally {
      if (request === renderedRequest.current) {
        setIsLoadingRaw(false);
        setHasLoadedRendered(true);
      }
    }
  }, [id]);

  // ── Toggle switch handler (immediate save) ────────────────────
  const handleToggle = useCallback(
    async (field: string, value: boolean) => {
      if (!id || !host || !canEditProxyHost) return;
      if (
        field === "sslEnabled" &&
        value &&
        !host.sslCertificateId &&
        !host.internalCertificateId
      ) {
        toast.error("Select an SSL certificate before enabling HTTPS");
        return;
      }
      try {
        const updated = await api.updateProxyHost(id, { [field]: value } as any);
        syncHostState(updated);
        toast.success(
          `${field.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())} updated`
        );
      } catch (err) {
        toastApiError(err, "Failed to update");
      }
    },
    [canEditProxyHost, id, host, syncHostState]
  );

  const handleSaveSsl = useCallback(async () => {
    if (!id || !canEditProxyHost) return;
    if (sslEnabled && !sslCertificateId && !host?.internalCertificateId) {
      toast.error("Select an SSL certificate before enabling HTTPS");
      return;
    }
    setIsSavingSsl(true);
    try {
      const updated = await api.updateProxyHost(id, {
        sslEnabled,
        sslForced: sslEnabled ? sslForced : false,
        http2Support: sslEnabled ? http2Support : false,
        sslCertificateId: sslCertificateId || null,
      });
      syncHostState(updated, { forceSections: ["ssl"] });
      toast.success("SSL settings updated");
    } catch (err) {
      toastApiError(err, "Failed to update SSL settings");
    } finally {
      setIsSavingSsl(false);
    }
  }, [
    canEditProxyHost,
    host?.internalCertificateId,
    http2Support,
    id,
    sslCertificateId,
    sslEnabled,
    sslForced,
    syncHostState,
  ]);

  const defaultTemplate = useMemo(
    () => nginxTemplates.find((t) => t.isBuiltin && t.type === host?.type) ?? null,
    [nginxTemplates, host?.type]
  );

  const selectedTemplate = useMemo(
    () =>
      (nginxTemplateId ? nginxTemplates.find((t) => t.id === nginxTemplateId) : defaultTemplate) ??
      null,
    [defaultTemplate, nginxTemplates, nginxTemplateId]
  );

  const userTemplates = useMemo(
    () => nginxTemplates.filter((t) => !t.isBuiltin && t.type === host?.type),
    [nginxTemplates, host?.type]
  );

  const normalizeTemplateVariables = useCallback(
    (templateId: string, vars: Record<string, string | number | boolean>) => {
      const template = templateId
        ? nginxTemplates.find((t) => t.id === templateId)
        : nginxTemplates.find((t) => t.isBuiltin && t.type === host?.type);
      if (!template?.variables?.length) return {};

      const next: Record<string, string | number | boolean> = {};
      for (const def of template.variables) {
        if (vars[def.name] !== undefined) {
          next[def.name] = vars[def.name];
        } else if (def.name === "cacheEnabled" && host?.type === "proxy") {
          next[def.name] = host.cacheEnabled;
        } else if (def.name === "cacheMaxAge" && host?.type === "proxy") {
          next[def.name] = host.cacheOptions?.maxAge ?? 3600;
        } else if (def.name === "rateLimitMode" && host?.type === "proxy") {
          next[def.name] = host.rateLimitMode ?? (host.rateLimitEnabled ? "custom" : "inherit");
        } else if (def.name === "rateLimitRPS" && host?.type === "proxy") {
          next[def.name] = host.rateLimitOptions?.requestsPerSecond ?? 1000;
        } else if (def.name === "rateLimitBurst" && host?.type === "proxy") {
          next[def.name] = host.rateLimitOptions?.burst ?? 3000;
        } else if (def.name === "connectionsPerIp" && host?.type === "proxy") {
          next[def.name] = host.rateLimitOptions?.connectionsPerIp ?? 1000;
        } else if (def.default !== undefined) {
          next[def.name] = def.default;
        } else if (def.type === "boolean") {
          next[def.name] = false;
        } else if (def.type === "number") {
          next[def.name] = 0;
        } else {
          next[def.name] = "";
        }
      }
      return next;
    },
    [host, nginxTemplates]
  );

  const effectiveTemplateVariables = useMemo(
    () => normalizeTemplateVariables(nginxTemplateId, templateVariables),
    [nginxTemplateId, normalizeTemplateVariables, templateVariables]
  );

  const hasTemplateSettingsChanged = useMemo(() => {
    if (!host) return false;
    const currentId = host.nginxTemplateId || "";
    const currentVars = normalizeTemplateVariables(currentId, host.templateVariables || {});
    const nextVars = normalizeTemplateVariables(nginxTemplateId, templateVariables);
    const builtinsChanged =
      (host.type === "proxy" &&
        (host.forwardScheme !== templateForwardScheme ||
          (host.forwardHost || "") !== templateForwardHost ||
          (host.forwardPort || 80) !== templateForwardPort)) ||
      (host.type === "redirect" &&
        ((host.redirectUrl || "") !== templateRedirectUrl ||
          (host.redirectStatusCode || 301) !== templateRedirectStatusCode));

    return (
      builtinsChanged ||
      currentId !== nginxTemplateId ||
      JSON.stringify(currentVars) !== JSON.stringify(nextVars)
    );
  }, [
    host,
    nginxTemplateId,
    normalizeTemplateVariables,
    templateForwardHost,
    templateForwardPort,
    templateForwardScheme,
    templateRedirectStatusCode,
    templateRedirectUrl,
    templateVariables,
  ]);

  const handleTemplateSelectionChange = useCallback(
    (value: string) => {
      const nextId = value || "";
      setNginxTemplateId(nextId);
      setTemplateVariables((prev) => normalizeTemplateVariables(nextId, prev));
    },
    [normalizeTemplateVariables]
  );

  const handleTemplateVariableChange = useCallback(
    (name: string, value: string | number | boolean) => {
      setTemplateVariables((prev) => ({ ...prev, [name]: value }));
    },
    []
  );

  const handleSaveTemplateSettings = useCallback(async () => {
    if (!id || !canEditProxyHost) return;
    setIsSavingTemplate(true);
    try {
      const vars = normalizeTemplateVariables(nginxTemplateId, templateVariables);
      const hasTemplateVariable = (name: string) =>
        selectedTemplate?.variables?.some((variable) => variable.name === name) ?? false;
      const nextCacheEnabled = hasTemplateVariable("cacheEnabled")
        ? vars.cacheEnabled === true
        : cacheEnabled;
      const nextCacheMaxAge = hasTemplateVariable("cacheMaxAge")
        ? Number(vars.cacheMaxAge ?? 3600)
        : cacheMaxAge;
      const nextRateLimitMode = hasTemplateVariable("rateLimitMode")
        ? vars.rateLimitMode === "custom" || vars.rateLimitMode === "disabled"
          ? vars.rateLimitMode
          : "inherit"
        : rateLimitMode;
      const nextRateLimitRPS = hasTemplateVariable("rateLimitRPS")
        ? Number(vars.rateLimitRPS ?? 1000)
        : rateLimitRPS;
      const nextRateLimitBurst = hasTemplateVariable("rateLimitBurst")
        ? Number(vars.rateLimitBurst ?? 3000)
        : rateLimitBurst;
      const nextConnectionsPerIp = hasTemplateVariable("connectionsPerIp")
        ? Number(vars.connectionsPerIp ?? 1000)
        : rateLimitConnectionsPerIp;
      const updated = await api.updateProxyHost(id, {
        nginxTemplateId: nginxTemplateId || null,
        templateVariables: vars,
        cacheEnabled: nextCacheEnabled,
        cacheOptions: { maxAge: nextCacheMaxAge },
        rateLimitMode: nextRateLimitMode,
        rateLimitEnabled: nextRateLimitMode === "custom",
        rateLimitOptions: {
          requestsPerSecond: nextRateLimitRPS,
          burst: nextRateLimitBurst,
          connectionsPerIp: nextConnectionsPerIp,
        },
        ...(host?.type === "proxy" && host.upstreamKind === "manual"
          ? {
              forwardScheme: templateForwardScheme,
              forwardHost: templateForwardHost,
              forwardPort: templateForwardPort,
            }
          : {}),
        ...(host?.type === "redirect"
          ? {
              redirectUrl: templateRedirectUrl,
              redirectStatusCode: templateRedirectStatusCode,
            }
          : {}),
      });
      syncHostState(updated, { forceSections: ["template"] });
      toast.success("Template settings updated");
    } catch (err) {
      toastApiError(err, "Failed to update template settings");
    } finally {
      setIsSavingTemplate(false);
    }
  }, [
    host,
    cacheEnabled,
    cacheMaxAge,
    id,
    canEditProxyHost,
    nginxTemplateId,
    normalizeTemplateVariables,
    rateLimitBurst,
    rateLimitConnectionsPerIp,
    rateLimitMode,
    rateLimitRPS,
    selectedTemplate,
    templateForwardHost,
    templateForwardPort,
    templateForwardScheme,
    templateRedirectStatusCode,
    templateRedirectUrl,
    templateVariables,
    syncHostState,
  ]);

  const handleSaveHeaders = async () => {
    if (!id || !canEditProxyHost) return;
    setIsSavingCustom(true);
    try {
      const updated = await api.updateProxyHost(id, {
        customHeaders: customHeaders.filter((h) => h.name.trim() !== ""),
      });
      syncHostState(updated, { forceSections: ["headers"] });
      toast.success("Custom headers saved");
    } catch (err) {
      toastApiError(err, "Failed to save custom headers");
    } finally {
      setIsSavingCustom(false);
    }
  };

  const handleSaveRewrites = async () => {
    if (!id || !canEditProxyHost) return;
    setIsSavingCustom(true);
    try {
      const updated = await api.updateProxyHost(id, {
        customRewrites: customRewrites.filter((rule) => rule.source.trim() !== ""),
      });
      syncHostState(updated, { forceSections: ["rewrites"] });
      toast.success("URL rewrites saved");
    } catch (err) {
      toastApiError(err, "Failed to save URL rewrites");
    } finally {
      setIsSavingCustom(false);
    }
  };

  const handleSaveHealthCheck = useCallback(async () => {
    if (!id || !canEditProxyHost) return;
    setIsSavingHealthCheck(true);
    try {
      const updated = await api.updateProxyHost(id, {
        healthCheckEnabled,
        healthCheckUrl,
        healthCheckExpectedStatus,
        healthCheckExpectedBody: healthCheckExpectedBody || null,
        healthCheckBodyMatchMode,
        healthCheckSlowThreshold,
      });
      syncHostState(updated, { forceSections: ["health"] });
      setHealthHistory(updated.healthCheckEnabled ? (updated.healthHistory ?? []) : []);
      toast.success("Health check settings updated");
    } catch (err) {
      toastApiError(err, "Failed to update health checks");
    } finally {
      setIsSavingHealthCheck(false);
    }
  }, [
    canEditProxyHost,
    healthCheckBodyMatchMode,
    healthCheckEnabled,
    healthCheckExpectedBody,
    healthCheckExpectedStatus,
    healthCheckSlowThreshold,
    healthCheckUrl,
    id,
    syncHostState,
  ]);

  // ── Validate config — returns true if valid ──────────────────
  const handleValidate = async (): Promise<boolean> => {
    if ((isRawMode && !canWriteRawConfig) || (!isRawMode && !canViewAdvancedConfig)) return false;
    try {
      const configToValidate = isRawMode ? rawConfig : advancedConfig;
      const result = await api.validateProxyConfig(
        configToValidate,
        isRawMode ? "raw" : "advanced",
        id
      );

      if (result.valid) {
        setEditorErrorLines([]);
        toast.success("Configuration is valid");
        return true;
      }

      // Parse line numbers from error messages and show individual toasts
      const lineNums: number[] = [];
      for (const err of result.errors ?? []) {
        toast.error(err);
        const match = err.match(/line (\d+)/i);
        if (match) lineNums.push(Number(match[1]));
      }
      setEditorErrorLines(lineNums);
      return false;
    } catch (err) {
      toastApiError(err, "Validation failed");
      return false;
    }
  };

  // ── Save advanced config ──────────────────────────────────────
  const handleSaveAdvanced = async () => {
    if (!id || !canViewAdvancedConfig) return;
    if (advancedConfig) {
      const valid = await handleValidate();
      if (!valid) return;
    }
    setIsSavingAdvanced(true);
    try {
      const updated = await saveProxyHostAdvancedConfig(api, id, advancedConfig);
      syncHostState(updated, { forceSections: ["advanced"] });
      toast.success("Advanced config saved");
    } catch (err) {
      toastApiError(err, "Failed to save advanced config");
    } finally {
      setIsSavingAdvanced(false);
    }
  };

  // ── Save raw config ───────────────────────────────────────────
  const handleSaveRaw = async () => {
    if (!id || !canWriteRawConfig) return;
    const valid = await handleValidate();
    if (!valid) return;
    setIsSavingRaw(true);
    try {
      const updated = await api.updateProxyHost(id, { rawConfig });
      syncHostState(updated, { forceSections: ["raw"] });
      toast.success("Raw config saved");
    } catch (err) {
      toastApiError(err, "Failed to save raw config");
    } finally {
      setIsSavingRaw(false);
    }
  };

  // ── Delete host ───────────────────────────────────────────────
  const handleDelete = async () => {
    if (!host) return;
    const deletingHostId = host.id;
    const routeName = host.domainNames[0] || host.slug;
    const ok = await confirmAction(
      {
        title: "Delete Route",
        description: `Are you sure you want to delete the route "${routeName}"? This action cannot be undone.`,
        confirmLabel: "Delete",
      },
      async () => {
        try {
          await api.deleteProxyHost(deletingHostId);
          return true;
        } catch (err) {
          toastApiError(err, "Failed to delete route");
          return false;
        }
      }
    );
    if (!ok) return;
    usePinnedProxiesStore.getState().removePin(deletingHostId);
    useFolderStore.getState().removeHost(deletingHostId);
    toast.success("Route deleted");
    navigate("/routes");
  };

  const handleMaintenance = async () => {
    if (!host || !canEditProxyHost) return;
    const entering = !host.maintenanceEnabled;
    if (entering) {
      const ok = await confirm({
        title: "Enable Maintenance Mode",
        description:
          "All requests to this route will receive HTTP 503 and managed health checks will pause until maintenance is disabled.",
        confirmLabel: "Enable Maintenance",
      });
      if (!ok) return;
    }

    setIsMaintenanceToggling(true);
    try {
      const updated = await api.toggleProxyMaintenance(host.id, entering);
      api.invalidateCache();
      syncHostState(updated);
      toast.success(entering ? "Maintenance mode enabled" : "Maintenance mode disabled");
      if (!entering && updated.healthCheckEnabled) setHealthHistory([]);
    } catch (err) {
      toastApiError(err, "Failed to update maintenance mode");
    } finally {
      setIsMaintenanceToggling(false);
    }
  };

  const handleCreateMaintenanceAccessCode = async () => {
    if (!host || !hasScope(`proxy:maintenance:bypass:${host.id}`)) return;
    setIsCreatingMaintenanceAccessCode(true);
    try {
      const { code } = await api.createProxyMaintenanceAccessCode(host.id);
      setMaintenanceAccessCode(code);
    } catch (err) {
      toastApiError(err, "Failed to create maintenance access code");
    } finally {
      setIsCreatingMaintenanceAccessCode(false);
    }
  };

  // Same check as POST /proxy-hosts/:id/tls/resync: system routes need admin:update,
  // other routes proxy:edit (admin:update still accepted for one release).
  const canRetryTlsDelivery = (target: ProxyHost) =>
    hasScope("admin:update") || (!target.isSystem && hasScope(`proxy:edit:${target.id}`));
  const handleTlsResync = async () => {
    if (!host || !canRetryTlsDelivery(host)) return;
    setIsTlsResyncing(true);
    try {
      await api.resyncProxyHostTls(host.id);
      await loadHost(true);
      toast.success("TLS synchronization completed");
    } catch (err) {
      toastApiError(err, "Failed to synchronize TLS configuration");
    } finally {
      setIsTlsResyncing(false);
    }
  };

  // ── Derived values ────────────────────────────────────────────
  const isRawMode = host?.rawConfigEnabled ?? false;
  const isSystemHost = host?.isSystem ?? false;
  const maintenanceActionAvailable =
    !!host &&
    (!isOpfieldPublicRoute(host, opfieldPublicUrl) || host.maintenanceEnabled) &&
    (host.maintenanceEnabled ||
      (host.enabled && host.type === "proxy" && !host.rawConfigEnabled && !host.isSystem));
  const canIssueMaintenanceAccessCode =
    !!host && host.maintenanceEnabled && hasScope(`proxy:maintenance:bypass:${host.id}`);
  const canResyncTls =
    !!host &&
    host.sslEnabled &&
    host.enabled &&
    canRetryTlsDelivery(host) &&
    host.tlsDistribution?.status !== "ready";

  const handleAccessListChange = useCallback(
    async (value: string) => {
      if (!id || !canEditProxyHost) return;

      setAccessListId(value);

      try {
        const updated = await saveProxyHostAccessList(api, id, value);
        syncHostState(updated);
        toast.success("Access list updated");
      } catch (err) {
        setAccessListId(host?.accessListId || "");
        toastApiError(err, "Failed to update");
      }
    },
    [canEditProxyHost, host?.accessListId, id, syncHostState]
  );

  // Track changes per section
  const hasHeadersChanged = useMemo(
    () => !!host && JSON.stringify(customHeaders) !== JSON.stringify(host.customHeaders || []),
    [host, customHeaders]
  );
  const hasRewritesChanged = useMemo(
    () => !!host && JSON.stringify(customRewrites) !== JSON.stringify(host.customRewrites || []),
    [host, customRewrites]
  );
  const hasSslSettingsChanged = useMemo(
    () =>
      !!host &&
      (host.sslEnabled !== sslEnabled ||
        host.sslForced !== sslForced ||
        host.http2Support !== http2Support ||
        (host.sslCertificateId || "") !== sslCertificateId),
    [host, http2Support, sslCertificateId, sslEnabled, sslForced]
  );
  const hasHealthCheckSettingsChanged = useMemo(
    () =>
      !!host &&
      (host.healthCheckEnabled !== healthCheckEnabled ||
        (host.healthCheckUrl || "/") !== healthCheckUrl ||
        (host.healthCheckExpectedStatus ?? null) !== healthCheckExpectedStatus ||
        (host.healthCheckExpectedBody || "") !== healthCheckExpectedBody ||
        (host.healthCheckBodyMatchMode || "includes") !== healthCheckBodyMatchMode ||
        (host.healthCheckSlowThreshold ?? 3) !== healthCheckSlowThreshold),
    [
      healthCheckBodyMatchMode,
      healthCheckEnabled,
      healthCheckExpectedBody,
      healthCheckExpectedStatus,
      healthCheckSlowThreshold,
      healthCheckUrl,
      host,
    ]
  );
  const hasAdvancedConfigChanged = !!host && (host.advancedConfig || "") !== advancedConfig;
  const hasRawConfigChanged = !!host && (host.rawConfig || "") !== rawConfig;

  dirtySectionsRef.current = {
    template: hasTemplateSettingsChanged,
    headers: hasHeadersChanged,
    rewrites: hasRewritesChanged,
    ssl: hasSslSettingsChanged,
    health: hasHealthCheckSettingsChanged,
    advanced: hasAdvancedConfigChanged,
    raw: hasRawConfigChanged,
  };

  // Navigate away from disabled tabs when raw mode changes
  useEffect(() => {
    if (isRawMode && (activeTab === "settings" || activeTab === "advanced")) {
      setActiveTab("details");
    }
  }, [activeTab, isRawMode, setActiveTab]);

  useEffect(() => {
    if (activeTab === "raw" && host && !isRawMode) {
      void loadRenderedConfig();
    }
  }, [activeTab, host, isRawMode, loadRenderedConfig]);

  // ── Loading state ─────────────────────────────────────────────
  if (isLoading) return <ProxyHostDetailSkeleton />;
  if (!host)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Proxy host not found
      </div>
    );

  const hostHealth = effectiveHealthStatus(host);

  return (
    <PageTransition>
      <div
        className={cn(
          "h-full flex flex-col p-6 gap-4",
          activeTab === "raw" || activeTab === "advanced" || activeTab === "logs"
            ? "overflow-hidden"
            : "overflow-y-auto"
        )}
      >
        {/* ── Header ─────────────────────────────────────────── */}
        <PageHeader
          className="shrink-0"
          leading={<PageBackButton onClick={() => navigate("/routes")} />}
          title={host.domainNames[0] || "Route"}
          badges={
            <>
              <Badge
                className="shrink-0"
                variant={TYPE_BADGE[host.type] ?? "secondary"}
                size="inline"
              >
                {host.type}
              </Badge>
              {host.maintenanceEnabled ? (
                <Badge className="shrink-0" variant="warning" size="inline">
                  Maintenance
                </Badge>
              ) : (
                <Badge
                  className="shrink-0"
                  variant={HEALTH_BADGE[hostHealth] ?? "secondary"}
                  size="inline"
                >
                  {HEALTH_LABEL[hostHealth] ?? hostHealth}
                </Badge>
              )}
            </>
          }
          description={
            <span className="flex items-center gap-2">
              {host.domainNames.length > 1 ? (
                <span>
                  +{host.domainNames.length - 1} more domain
                  {host.domainNames.length > 2 ? "s" : ""}
                </span>
              ) : null}
              {host.type === "proxy" ? <ProxyUpstreamTarget host={host} size="inline" /> : null}
              {host.type === "proxy" && host.secureLinkActive ? (
                <Badge
                  variant={host.healthStatus === "offline" ? "destructive" : "success"}
                  size="inline"
                >
                  {host.healthStatus === "offline" ? "Secure Link Offline" : "Secure Link"}
                </Badge>
              ) : null}
              {host.type === "redirect" && host.redirectUrl ? ` \u2192 ${host.redirectUrl}` : null}
              {host.app ? <AppMembershipLink app={host.app} /> : null}
            </span>
          }
          actions={
            <ResponsiveHeaderActions
              actions={[
                {
                  label: "Pin",
                  icon: <Pin className="h-4 w-4" />,
                  onClick: () => setPinOpen(true),
                },
                ...(canEditProxyHost
                  ? [
                      {
                        label: "Edit",
                        icon: <Pencil className="h-4 w-4" />,
                        onClick: () => setEditOpen(true),
                      },
                    ]
                  : []),
                ...(canEditProxyHost
                  ? [
                      {
                        label: host.maintenanceEnabled
                          ? "Disable Maintenance"
                          : "Enable Maintenance",
                        icon: <Wrench className="h-4 w-4" />,
                        onClick: handleMaintenance,
                        disabled: isMaintenanceToggling || !maintenanceActionAvailable,
                      },
                    ]
                  : []),
                ...(canIssueMaintenanceAccessCode
                  ? [
                      {
                        label: "Create Maintenance Access Code",
                        icon: <KeyRound className="h-4 w-4" />,
                        onClick: handleCreateMaintenanceAccessCode,
                        disabled: isCreatingMaintenanceAccessCode,
                      },
                    ]
                  : []),
                ...(canResyncTls
                  ? [
                      {
                        label: "Retry TLS Sync",
                        icon: (
                          <RefreshCw className={cn("h-4 w-4", isTlsResyncing && "animate-spin")} />
                        ),
                        onClick: handleTlsResync,
                        disabled: isTlsResyncing,
                      },
                    ]
                  : []),
                ...(!isSystemHost && canDeleteProxyHost
                  ? [
                      {
                        label: "Delete",
                        icon: <Trash2 className="h-4 w-4" />,
                        onClick: handleDelete,
                        disabled: incidentHold.kept !== null,
                        disabledReason: incidentHold.kept ?? undefined,
                        destructive: true,
                        separatorBefore: true,
                      },
                    ]
                  : []),
              ]}
            >
              <Button
                variant="outline"
                size="icon"
                aria-label="Pin"
                onClick={() => setPinOpen(true)}
              >
                <Pin className="h-4 w-4" />
              </Button>
              {canEditProxyHost && (
                <Button variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="h-4 w-4" />
                  Edit
                </Button>
              )}
              {canEditProxyHost && (
                <Button
                  variant="outline"
                  onClick={handleMaintenance}
                  disabled={!maintenanceActionAvailable}
                  pending={isMaintenanceToggling}
                >
                  <Wrench className="h-4 w-4" />
                  {host.maintenanceEnabled ? "Disable Maintenance" : "Enable Maintenance"}
                </Button>
              )}
              {canIssueMaintenanceAccessCode && (
                <Button
                  variant="outline"
                  onClick={handleCreateMaintenanceAccessCode}
                  pending={isCreatingMaintenanceAccessCode}
                >
                  <KeyRound className="h-4 w-4" />
                  Create Maintenance Access Code
                </Button>
              )}
              {canResyncTls && (
                <Button variant="outline" onClick={handleTlsResync} pending={isTlsResyncing}>
                  <RefreshCw className="h-4 w-4" />
                  Retry TLS Sync
                </Button>
              )}
              {!isSystemHost && canDeleteProxyHost && (
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={incidentHold.kept !== null}
                  title={incidentHold.kept ?? undefined}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        <MemberIsolatedNotice app={host.app} memberApp={memberApp} onChanged={reloadMemberApp} />

        {/* ── Health bars (only when healthCheckEnabled) ──────── */}
        {host.healthCheckEnabled && (
          <HealthBars history={healthHistory} currentStatus={host.healthStatus} />
        )}

        {host.maintenanceEnabled && (
          <Notice tone="warning" title="Maintenance mode is active">
            <p>User requests receive HTTP 503 and managed health checks are paused.</p>
          </Notice>
        )}

        {/* ── Raw mode warning banner ────────────────────────── */}
        {isRawMode && (
          <Notice tone="warning" title="Raw mode is active">
            <p>Template rendering is bypassed; the config is sent directly to the daemon.</p>
          </Notice>
        )}

        {/* ── Tabs ───────────────────────────────────────────── */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            setActiveTab(v);
            if (v === "raw" && !isRawMode) loadRenderedConfig();
          }}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabsList className="shrink-0">
            {visibleTabs.includes("details") && (
              <TabsTrigger value="details" className="gap-1.5">
                Details
              </TabsTrigger>
            )}
            {visibleTabs.includes("settings") && (
              <TabsTrigger value="settings" disabled={isRawMode} className="gap-1.5">
                Settings
              </TabsTrigger>
            )}
            {visibleTabs.includes("advanced") && (
              <TabsTrigger value="advanced" disabled={isRawMode} className="gap-1.5">
                Advanced
              </TabsTrigger>
            )}
            {visibleTabs.includes("secure-link") && (
              <TabsTrigger value="secure-link" className="gap-1.5">
                Link Runtime
              </TabsTrigger>
            )}
            {visibleTabs.includes("raw") && (
              <TabsTrigger value="raw" className="gap-1.5">
                Raw Config
              </TabsTrigger>
            )}
            <TabsTrigger value="logs" className="gap-1.5">
              Logs
            </TabsTrigger>
          </TabsList>

          {/* ── Details Tab ────────────────────────────────────── */}
          {visibleTabs.includes("details") && (
            <TabsContent value="details" className="pb-6">
              <DetailsTab host={host} />
            </TabsContent>
          )}

          {/* ── Settings Tab ────────────────────────────────────── */}
          {visibleTabs.includes("settings") && (
            <TabsContent value="settings" className="pb-6">
              <SettingsTab
                host={host}
                secureLinkRemovalDisabledReason={incidentHold.kept}
                onHostUpdated={syncHostState}
                onToggle={handleToggle}
                customHeaders={customHeaders}
                setCustomHeaders={setCustomHeaders}
                customRewrites={customRewrites}
                setCustomRewrites={setCustomRewrites}
                onSaveHeaders={handleSaveHeaders}
                onSaveRewrites={handleSaveRewrites}
                isSavingCustom={isSavingCustom}
                accessListId={accessListId}
                accessLists={accessLists}
                onAccessListChange={handleAccessListChange}
                sslCerts={sslCerts}
                sslEnabled={sslEnabled}
                setSslEnabled={setSslEnabled}
                sslForced={sslForced}
                setSslForced={setSslForced}
                http2Support={http2Support}
                setHttp2Support={setHttp2Support}
                sslCertificateId={sslCertificateId}
                setSslCertificateId={setSslCertificateId}
                onSaveSsl={handleSaveSsl}
                isSavingSsl={isSavingSsl}
                hasSslSettingsChanged={hasSslSettingsChanged}
                nginxTemplates={userTemplates}
                nginxTemplateId={nginxTemplateId}
                onNginxTemplateChange={handleTemplateSelectionChange}
                selectedTemplate={selectedTemplate}
                templateVariables={effectiveTemplateVariables}
                onTemplateVariableChange={handleTemplateVariableChange}
                templateRedirectUrl={templateRedirectUrl}
                setTemplateRedirectUrl={setTemplateRedirectUrl}
                templateRedirectStatusCode={templateRedirectStatusCode}
                setTemplateRedirectStatusCode={setTemplateRedirectStatusCode}
                onSaveTemplateSettings={handleSaveTemplateSettings}
                isSavingTemplate={isSavingTemplate}
                hasTemplateSettingsChanged={hasTemplateSettingsChanged}
                canManage={canEditProxyHost}
                hasHeadersChanged={hasHeadersChanged}
                hasRewritesChanged={hasRewritesChanged}
                healthCheckEnabled={healthCheckEnabled}
                setHealthCheckEnabled={setHealthCheckEnabled}
                healthCheckUrl={healthCheckUrl}
                setHealthCheckUrl={setHealthCheckUrl}
                healthCheckExpectedStatus={healthCheckExpectedStatus}
                setHealthCheckExpectedStatus={setHealthCheckExpectedStatus}
                healthCheckExpectedBody={healthCheckExpectedBody}
                setHealthCheckExpectedBody={setHealthCheckExpectedBody}
                healthCheckBodyMatchMode={healthCheckBodyMatchMode}
                setHealthCheckBodyMatchMode={setHealthCheckBodyMatchMode}
                healthCheckSlowThreshold={healthCheckSlowThreshold}
                setHealthCheckSlowThreshold={setHealthCheckSlowThreshold}
                onSaveHealthCheck={handleSaveHealthCheck}
                isSavingHealthCheck={isSavingHealthCheck}
                hasHealthCheckSettingsChanged={hasHealthCheckSettingsChanged}
                canResyncTls={canResyncTls}
                isTlsResyncing={isTlsResyncing}
                onTlsResync={handleTlsResync}
                optionsLoading={accessListsLoading || sslCertsLoading || nginxTemplatesLoading}
              />
            </TabsContent>
          )}

          {/* ── Advanced Tab ───────────────────────────────────── */}
          {visibleTabs.includes("advanced") && (
            <TabsContent value="advanced" className="flex flex-col flex-1 min-h-0">
              <AdvancedTab
                advancedConfig={advancedConfig}
                setAdvancedConfig={setAdvancedConfig}
                editorErrorLines={editorErrorLines}
                setEditorErrorLines={setEditorErrorLines}
                onValidate={handleValidate}
                onSaveAdvanced={handleSaveAdvanced}
                isSavingAdvanced={isSavingAdvanced}
                dirty={hasAdvancedConfigChanged}
                canManage={!!id && hasScope(`proxy:advanced:${id}`)}
              />
            </TabsContent>
          )}

          {visibleTabs.includes("secure-link") && (
            <TabsContent value="secure-link" className="pb-6">
              <SecureLinkTab hostId={id!} />
            </TabsContent>
          )}

          {/* ── Raw Config Tab ─────────────────────────────────── */}
          {visibleTabs.includes("raw") && (
            <TabsContent value="raw" className="flex flex-col flex-1 min-h-0">
              <RawConfigTab
                key={id}
                hasLoadedRendered={hasLoadedRendered}
                isRawMode={isRawMode}
                rawConfig={rawConfig}
                setRawConfig={setRawConfig}
                renderedConfig={renderedConfig}
                isLoadingRaw={isLoadingRaw}
                isSavingRaw={isSavingRaw}
                editorErrorLines={editorErrorLines}
                setEditorErrorLines={setEditorErrorLines}
                onValidate={handleValidate}
                onSaveRaw={handleSaveRaw}
                onRefreshRendered={loadRenderedConfig}
                dirty={hasRawConfigChanged}
                canManage={canWriteRawConfig}
              />
            </TabsContent>
          )}

          {/* ── Logs Tab ───────────────────────────────────────── */}
          <TabsContent value="logs" className="flex flex-col flex-1 min-h-0">
            <LogsTab hostId={id!} />
          </TabsContent>
        </Tabs>
      </div>

      {/* ── Edit Dialog ──────────────────────────────────────── */}
      <CreateProxyHostDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        existingHost={host}
        onSuccess={(_, updatedHost) => {
          setEditOpen(false);
          if (updatedHost) {
            syncHostState(updatedHost);
            setHealthHistory(
              updatedHost.healthCheckEnabled ? (updatedHost.healthHistory ?? []) : []
            );
            if (updatedHost.slug !== routeSlug) {
              navigate(proxyHostRoute(updatedHost.slug, activeTab), { replace: true });
            }
            return;
          }
          loadHost(true);
        }}
      />

      <Dialog
        open={maintenanceAccessCode !== null}
        onOpenChange={(open) => {
          if (!open) setMaintenanceAccessCode(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Maintenance Access Code</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Share this one-time code only with the person who needs temporary access. It expires in
            5 minutes.
          </DialogDescription>
          <div className="flex min-w-0 border border-input bg-background">
            <Input
              value={displayedMaintenanceAccessCode ?? ""}
              readOnly
              aria-label="Maintenance access code"
              className="min-w-0 flex-1 border-0 bg-transparent font-mono focus-visible:ring-0"
            />
            <CopyButton
              value={displayedMaintenanceAccessCode ?? ""}
              label="maintenance access code"
              className="border-l border-border"
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Pin Dialog ───────────────────────────────────────── */}
      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pin Route</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <SwitchCard
              label="Add to dashboard"
              description="Show overview card on the dashboard"
              checked={isPinnedDashboard(id!)}
              onCheckedChange={() => toggleDashboard(id!)}
            />
            <SwitchCard
              label="Add to sidebar"
              description="Quick access link in the sidebar"
              checked={isPinnedSidebar(id!)}
              onCheckedChange={() => toggleSidebar(id!)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}

function ProxyHostDetailSkeleton() {
  return <DetailPageSkeleton label="Loading route" />;
}
