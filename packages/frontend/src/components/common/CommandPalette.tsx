import {
  Activity,
  ArrowUpCircle,
  Award,
  Bell,
  Bot,
  Box,
  Clock,
  FileText,
  FolderOpen,
  Globe2,
  HardDrive,
  Image,
  KeyRound,
  ListTodo,
  Lock,
  LogOut,
  Monitor,
  Moon,
  MousePointerClick,
  Network,
  PanelLeft,
  Plus,
  ScrollText,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  UserRound,
  Users,
  Webhook,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useInferenceQuotaSnapshot } from "@/components/ai/InferenceQuotaStatus";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { usePkiAvailable, useSiemAvailable } from "@/hooks/use-plan-gated-features";
import { type AppNavigationItemId, visibleNavigationGroups } from "@/lib/app-navigation";
import { hasCreationDestination } from "@/lib/creation-folders";
import { setDevForcedUpdateMode } from "@/lib/dev-force-updates";
import { hasLowInferenceUsage } from "@/lib/inference-self-usage";
import {
  CERTIFICATES_HUB,
  legacyPathForPath,
  type NavigationHub,
  ROUTES_HUB,
} from "@/lib/navigation-hubs";
import { isNodeProtected } from "@/lib/node-host-access";
import {
  resourceSearchHref,
  resourceSearchSecondaryText,
  resourceTypeIcon,
} from "@/lib/resource-presentation";
import { dockerContainerRoute, dockerDeploymentRoute, nodeRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useCommandPalettePageActions } from "@/stores/command-palette-page-actions";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { usePlanIncludes, useUnlicensedNavigationItems } from "@/stores/license-paywall";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { useUpdateStore } from "@/stores/update";
import { AI_SCOPE, type DockerContainer, type Node, type ResourceSearchResult } from "@/types";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PaletteEntry {
  id: string;
  label: string;
  detail?: string;
  keywords?: readonly string[];
  contexts?: readonly string[];
  icon: React.ElementType;
  iconNode?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
}

interface DeepLinkDefinition {
  id: string;
  label: string;
  href: string;
  icon: React.ElementType;
  /** Shown only while this sidebar item is; without one the link follows `visible` alone. */
  parentId?: AppNavigationItemId;
  keywords?: readonly string[];
  visible?: boolean;
}

/** Palette entries for the Routes and Certificates tabs, findable by their former page names. */
const HUB_TAB_LINKS: readonly {
  id: string;
  hub: NavigationHub;
  tab: string;
  label: string;
  icon: React.ElementType;
  keywords: readonly string[];
}[] = [
  {
    id: "domains",
    hub: ROUTES_HUB,
    tab: "domains",
    label: "Domains",
    icon: Globe2,
    keywords: ["routes", "dns", "cloudflare"],
  },
  {
    id: "ingress-groups",
    hub: ROUTES_HUB,
    tab: "ingress-groups",
    label: "Ingress Groups",
    icon: Network,
    keywords: ["routes", "sites", "failover", "multi-node", "availability", "nginx nodes"],
  },
  {
    id: "access-lists",
    hub: ROUTES_HUB,
    tab: "access-lists",
    label: "Access Lists",
    icon: ShieldAlert,
    keywords: ["routes", "acl", "ip rules", "basic auth"],
  },
  {
    id: "templates-nginx",
    hub: ROUTES_HUB,
    tab: "templates",
    label: "Nginx templates",
    icon: Award,
    keywords: ["routes", "templates", "nginx config"],
  },
  {
    id: "ssl-certificates-tab",
    hub: CERTIFICATES_HUB,
    tab: "ssl",
    label: "SSL Certificates",
    icon: Lock,
    keywords: ["certificates", "tls", "acme", "letsencrypt"],
  },
  {
    id: "authorities",
    hub: CERTIFICATES_HUB,
    tab: "authorities",
    label: "Authorities",
    icon: ShieldCheck,
    keywords: ["certificates", "ca", "certificate authority", "root", "intermediate", "pki"],
  },
  {
    id: "certificates",
    hub: CERTIFICATES_HUB,
    tab: "pki",
    label: "PKI Certificates",
    icon: FileText,
    keywords: ["certificates", "pki"],
  },
  {
    id: "templates-pki",
    hub: CERTIFICATES_HUB,
    tab: "templates",
    label: "Certificate templates",
    icon: Award,
    keywords: ["certificates", "templates", "pki templates"],
  },
];

function fuzzyMatch(text: string, query: string): number {
  if (!query) return 1;
  const words = query.split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  let score = 0;
  for (const word of words) {
    const index = lower.indexOf(word);
    if (index === -1) return 0;
    score +=
      index === 0 ||
      lower[index - 1] === " " ||
      lower[index - 1] === "-" ||
      lower[index - 1] === "/"
        ? 2
        : 1;
  }
  return score;
}

function entryScore(entry: PaletteEntry, query: string): number {
  return fuzzyMatch(
    [entry.label, entry.detail, ...(entry.keywords ?? [])].filter(Boolean).join(" "),
    query
  );
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [commandContainers, setCommandContainers] = useState<DockerContainer[]>([]);
  const [commandEntitiesPending, setCommandEntitiesPending] = useState(false);
  const [resourceResults, setResourceResults] = useState<ResourceSearchResult[]>([]);
  const [resourceSearchPending, setResourceSearchPending] = useState(false);
  const resourceSearchSequence = useRef(0);
  const resourceSearchAbortController = useRef<AbortController | null>(null);

  const { user, hasScope, hasAnyScope, hasScopedAccess, logout } = useAuthStore();
  const { setTheme, theme, toggleSidebar } = useUIStore();
  const pkiEnabled = usePkiAvailable();
  const siemEnabled = useSiemAvailable();
  const loggingEnabled = useSystemConfigStore((state) => state.config.features.loggingEnabled);
  const inferenceEnabled = useSystemConfigStore((state) => state.config.features.inferenceEnabled);
  const statusPageEnabled = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.statusPageEnabled ?? false
  );
  const unlicensedItems = useUnlicensedNavigationItems();
  const ingressGroupsInPlan = usePlanIncludes("multi-node-availability");
  const pagesEnabled = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.pagesEnabled ?? false
  );
  const hasCloudflareIntegration = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.hasCloudflareIntegration ?? false
  );
  const appsByMembers = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.appsByMembers ?? false
  );
  const recentPages = useUIStore((state) => state.recentPages);
  const commandActionUsage = useUIStore((state) => state.commandActionUsage);
  const recordCommandActionUsage = useUIStore((state) => state.recordCommandActionUsage);
  const pageActionRegistrations = useCommandPalettePageActions((state) => state.registrations);
  const resolvedPageStatus = useResolvedPageContext((state) => state.status);
  const resolvedPageRouteKey = useResolvedPageContext((state) => state.routeKey);
  const resolvedPageResource = useResolvedPageContext((state) => state.resource);
  const gatewayInferenceMode = useAIStore(
    (state) => state.providerStatus?.providerType === "gateway_inference"
  );
  const inferenceStreaming = useAIStore((state) => state.isStreaming);
  const aiEnabled = useAIStore((state) => state.isEnabled);
  const canViewInferenceUsage = hasScope("feat:ai:use");
  const dashboardInferenceUsage = useDashboardBootstrapStore(
    (state) => state.snapshot?.inferenceUsage
  );
  const dashboardBootstrapLoading = useDashboardBootstrapStore((state) => state.loading);
  const dashboardBootstrapStarted = useDashboardBootstrapStore(
    (state) => state.key !== null || state.request !== null || state.snapshot !== null
  );
  const waitForDashboardBootstrap = !dashboardBootstrapStarted || dashboardBootstrapLoading;
  const inferenceQuota = useInferenceQuotaSnapshot(
    gatewayInferenceMode &&
      canViewInferenceUsage &&
      inferenceEnabled &&
      hasScope("feat:ai:use") &&
      !waitForDashboardBootstrap,
    dashboardInferenceUsage
  );
  const isCommandMode = search.startsWith(">");
  const commandQuery = isCommandMode ? search.slice(1).trim().toLowerCase() : "";
  const searchQuery = isCommandMode ? "" : search.toLowerCase().trim();
  const aiScopeOk = hasScope(AI_SCOPE);
  // Tabs keep their former page's section, so quick-action usage recorded there still counts.
  const routeSection =
    legacyPathForPath(location.pathname).split("/").filter(Boolean)[0] ?? "dashboard";
  const activePageResource =
    resolvedPageStatus === "ready" &&
    resolvedPageRouteKey &&
    (location.pathname === resolvedPageRouteKey ||
      location.pathname.startsWith(`${resolvedPageRouteKey}/`))
      ? resolvedPageResource
      : null;
  const quickActionContext = activePageResource?.resourceType ?? routeSection;
  const currentPageActions = useMemo<PaletteEntry[]>(
    () =>
      Object.values(pageActionRegistrations)
        .filter(
          ({ routeKey }) =>
            location.pathname === routeKey || location.pathname.startsWith(`${routeKey}/`)
        )
        .flatMap(({ actions }) => actions)
        .filter(
          (action, index, actions) =>
            actions.findIndex((candidate) => candidate.id === action.id) === index
        )
        .map((action) => ({
          ...action,
          icon: MousePointerClick,
          iconNode: action.icon,
        })),
    [location.pathname, pageActionRegistrations]
  );

  useEffect(() => {
    if (!open) return;
    if (
      hasScopedAccess("nodes:details") ||
      hasScopedAccess("nodes:console") ||
      hasScopedAccess("nodes:files:read")
    ) {
      void api
        .listNodes({ limit: 100 })
        .then((response) => setNodes(response.data ?? []))
        .catch(() => setNodes([]));
    }
  }, [hasScopedAccess, open]);

  useEffect(() => {
    if (!open || !isCommandMode) return;
    if (!hasScopedAccess("docker:containers:view")) {
      setCommandContainers([]);
      setCommandEntitiesPending(false);
      return;
    }

    let cancelled = false;
    setCommandEntitiesPending(true);
    void api
      .listDockerContainerSnapshots()
      .then((items) => {
        if (!cancelled) setCommandContainers(items);
      })
      .catch(() => {
        if (!cancelled) setCommandContainers([]);
      })
      .finally(() => {
        if (!cancelled) setCommandEntitiesPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hasScopedAccess, isCommandMode, open]);

  useEffect(() => {
    if (!open || !gatewayInferenceMode || !canViewInferenceUsage || inferenceStreaming) return;
    void api.getInferenceSelfUsage().catch(() => {
      // The command palette remains usable when quota visibility is temporarily unavailable.
    });
  }, [canViewInferenceUsage, gatewayInferenceMode, inferenceStreaming, open]);

  useEffect(() => {
    const sequence = ++resourceSearchSequence.current;
    resourceSearchAbortController.current?.abort();
    resourceSearchAbortController.current = null;
    if (!open) return;
    if (isCommandMode || searchQuery.length < 2) {
      setResourceResults([]);
      setResourceSearchPending(false);
      return;
    }

    setResourceSearchPending(true);
    const abortController = new AbortController();
    resourceSearchAbortController.current = abortController;
    const timeout = window.setTimeout(() => {
      void api
        .searchResources(searchQuery, { limit: 20, signal: abortController.signal })
        .then((response) => {
          if (resourceSearchSequence.current === sequence) {
            setResourceResults(response.results);
          }
        })
        .catch(() => {
          if (resourceSearchSequence.current === sequence) setResourceResults([]);
        })
        .finally(() => {
          if (resourceSearchSequence.current === sequence) setResourceSearchPending(false);
        });
    }, 200);

    return () => {
      window.clearTimeout(timeout);
      abortController.abort();
      if (resourceSearchAbortController.current === abortController) {
        resourceSearchAbortController.current = null;
      }
    };
  }, [isCommandMode, open, searchQuery]);

  const handleSelect = (callback: () => void) => {
    callback();
    onOpenChange(false);
  };

  const handleActionSelect = (entry: PaletteEntry) => {
    if (entry.disabled) return;
    if (user?.id) {
      recordCommandActionUsage(user.id, quickActionContext, entry.id);
    }
    handleSelect(entry.action);
  };

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      logout();
    }
    navigate("/login");
  }, [logout, navigate]);

  const askAI = (query: string) => {
    if (inferenceQuota.exhausted) return;
    const systemPrompt = `The user typed "${query}" in the command palette search but found no matching pages, resources, or actions. They are looking for help or information. Please ANSWER their question or explain how to do what they're asking about. Do NOT perform any actions, do NOT create or modify resources — just explain step by step how they can do it themselves through the UI or provide the information they need.`;
    const wrapped = `<system-instruction>${systemPrompt}</system-instruction>\n${query}`;
    useUIStore.getState().setAIPanelOpen(true);
    const store = useAIStore.getState();
    if (store.isConnected) {
      store.sendMessage(wrapped);
    } else {
      void store.connect().then(() => useAIStore.getState().sendMessage(wrapped));
    }
  };

  const handleAskAI = (query: string) => {
    if (aiEnabled === false) {
      window.dispatchEvent(new CustomEvent("gateway:open-ai-workspace"));
      return;
    }
    askAI(query);
  };

  const navigationGroups = useMemo(
    () =>
      visibleNavigationGroups({
        scopes: user?.scopes ?? [],
        unlicensedItems,
        ingressGroupsInPlan,
        pkiEnabled,
        siemEnabled,
        loggingEnabled,
        inferenceEnabled,
        hasLowInferenceUsage: hasLowInferenceUsage(dashboardInferenceUsage ?? null),
        statusPageEnabled,
        pagesEnabled,
        hasCloudflareIntegration,
        appsByMembers,
      }),
    [
      appsByMembers,
      dashboardInferenceUsage,
      hasCloudflareIntegration,
      inferenceEnabled,
      loggingEnabled,
      pkiEnabled,
      pagesEnabled,
      siemEnabled,
      statusPageEnabled,
      unlicensedItems,
      ingressGroupsInPlan,
      user?.scopes,
    ]
  );

  const baseNavigationEntries = useMemo<PaletteEntry[]>(
    () =>
      navigationGroups.flatMap((group) =>
        group.items.map((item) => ({
          id: `navigation:${item.id}`,
          label: item.name,
          icon: item.icon,
          keywords: item.keywords,
          shortcut: item.shortcutKey ? `⌘${item.shortcutKey}` : undefined,
          action: () => navigate(item.href),
        }))
      ),
    [navigate, navigationGroups]
  );

  const deepNavigationEntries = useMemo<PaletteEntry[]>(() => {
    const accessibleParents = new Set(
      navigationGroups.flatMap((group) => group.items.map((item) => item.id))
    );
    const links: DeepLinkDefinition[] = [
      {
        id: "profile",
        label: "Profile",
        href: "/profile",
        icon: UserRound,
        keywords: ["account", "preferences", "authorizations", "tokens", "oauth"],
      },
      {
        id: "profile-preferences",
        label: "Profile preferences",
        href: "/profile/preferences",
        icon: UserRound,
        keywords: ["theme", "appearance"],
      },
      {
        id: "profile-authorizations",
        label: "Profile authorizations",
        href: "/profile/authorizations",
        icon: KeyRound,
        keywords: ["oauth", "tokens", "sessions"],
      },
      ...HUB_TAB_LINKS.flatMap((link) => {
        const tab = link.hub.tabs.find((candidate) => candidate.value === link.tab);
        if (!tab) return [];
        return [
          {
            id: link.id,
            label: link.label,
            href: tab.path,
            icon: link.icon,
            keywords: link.keywords,
            visible: tab.canAccess({
              scopes: user?.scopes ?? [],
              pkiEnabled,
              ingressGroupsInPlan,
            }),
          },
        ];
      }),
      {
        id: "docker-containers",
        label: "Docker containers",
        href: "/docker/containers",
        icon: Box,
        parentId: "docker",
        visible: hasScopedAccess("docker:containers:view"),
      },
      {
        id: "docker-images",
        label: "Docker images",
        href: "/docker/images",
        icon: Image,
        parentId: "docker",
        visible: hasScopedAccess("docker:images:view"),
      },
      {
        id: "docker-volumes",
        label: "Docker volumes",
        href: "/docker/volumes",
        icon: HardDrive,
        parentId: "docker",
        visible: hasScopedAccess("docker:volumes:view"),
      },
      {
        id: "docker-networks",
        label: "Docker networks",
        href: "/docker/networks",
        icon: Network,
        parentId: "docker",
        visible: hasScopedAccess("docker:networks:view"),
      },
      {
        id: "docker-tasks",
        label: "Docker tasks",
        href: "/docker/tasks",
        icon: ListTodo,
        parentId: "docker",
        visible: hasScopedAccess("docker:tasks"),
      },
      {
        id: "logging-environments",
        label: "Logging environments",
        href: "/logging/environments",
        icon: ScrollText,
        parentId: "logging",
        visible: loggingEnabled && hasScopedAccess("logs:environments:view"),
      },
      {
        id: "logging-schemas",
        label: "Logging schemas",
        href: "/logging/schemas",
        icon: FileText,
        parentId: "logging",
        visible: loggingEnabled && hasScopedAccess("logs:schemas:view"),
      },
      {
        id: "notifications-alerts",
        label: "Notification alert rules",
        href: "/notifications/alerts",
        icon: Bell,
        parentId: "notifications",
        visible: hasAnyScope("notifications:alerts:view", "notifications:alerts:manage"),
      },
      {
        id: "notifications-webhooks",
        label: "Notification webhooks",
        href: "/notifications/webhooks",
        icon: Webhook,
        parentId: "notifications",
        visible: hasAnyScope("notifications:webhooks:view", "notifications:webhooks:manage"),
      },
      {
        id: "notifications-deliveries",
        label: "Notification deliveries",
        href: "/notifications/deliveries",
        icon: ScrollText,
        parentId: "notifications",
        visible: hasAnyScope("notifications:webhooks:view", "notifications:webhooks:manage"),
      },
      {
        id: "status-services",
        label: "Status page services",
        href: "/status-page/services",
        icon: Activity,
        parentId: "status-page",
      },
      {
        id: "status-incidents",
        label: "Status page incidents",
        href: "/status-page/incidents",
        icon: Activity,
        parentId: "status-page",
      },
      {
        id: "status-settings",
        label: "Status page settings",
        href: "/status-page/settings",
        icon: Settings,
        parentId: "status-page",
      },
      {
        id: "administration-users",
        label: "Administration users",
        href: "/administration/users",
        icon: Users,
        parentId: "administration",
        visible: hasScope("admin:users"),
      },
      {
        id: "administration-groups",
        label: "Administration groups",
        href: "/administration/groups",
        icon: Users,
        parentId: "administration",
        visible: hasScope("admin:groups"),
      },
      {
        id: "administration-audit",
        label: "Audit log",
        href: "/administration/audit",
        icon: ScrollText,
        parentId: "administration",
        visible: hasScope("admin:audit"),
      },
      {
        id: "settings-general",
        label: "General settings",
        href: "/settings/general",
        icon: Settings,
        parentId: "settings",
        visible: hasAnyScope(
          "settings:gateway:view",
          "settings:gateway:edit",
          "admin:update",
          "license:view",
          "license:manage"
        ),
      },
      {
        id: "settings-authentication",
        label: "Authentication settings",
        href: "/settings/authentication",
        icon: Settings,
        parentId: "settings",
        visible: hasAnyScope("settings:gateway:view", "settings:gateway:edit"),
      },
      {
        id: "settings-advanced",
        label: "Advanced settings",
        href: "/settings/advanced",
        icon: Settings,
        parentId: "settings",
        visible: hasAnyScope(
          "settings:gateway:view",
          "settings:gateway:edit",
          "docker:registries:view"
        ),
      },
      {
        id: "settings-features",
        label: "Feature settings",
        href: "/settings/features",
        icon: Settings,
        parentId: "settings",
        visible: hasAnyScope(
          "status-page:view",
          "housekeeping:view",
          "housekeeping:run",
          "housekeeping:configure"
        ),
      },
      {
        id: "settings-integrations",
        label: "Integration settings",
        href: "/settings/integrations",
        icon: Settings,
        parentId: "settings",
        visible: hasAnyScope(
          "integrations:hosting:view",
          "integrations:hosting:manage",
          "integrations:gitlab:view",
          "integrations:gitlab:manage",
          "integrations:cloudflare:view",
          "integrations:cloudflare:manage"
        ),
      },
      {
        id: "settings-inference",
        label: "Inference settings",
        href: "/settings/inference",
        icon: Sparkles,
        parentId: "settings",
        visible:
          inferenceEnabled &&
          hasAnyScope(
            "inference:providers:view",
            "inference:providers:manage",
            "inference:models:manage",
            "inference:limits:manage",
            "inference:usage:view"
          ),
      },
      {
        id: "settings-ai",
        label: "AI Workspace settings",
        href: "/settings/ai",
        icon: Bot,
        parentId: "settings",
        visible: hasScope("feat:ai:configure"),
      },
    ];

    return links
      .filter(
        (link) =>
          (link.parentId === undefined || accessibleParents.has(link.parentId)) &&
          link.visible !== false
      )
      .map((link) => ({
        id: `navigation:${link.id}`,
        label: link.label,
        icon: link.icon,
        keywords: link.keywords,
        action: () => navigate(link.href),
      }));
  }, [
    hasAnyScope,
    hasScope,
    hasScopedAccess,
    inferenceEnabled,
    loggingEnabled,
    navigate,
    navigationGroups,
    pkiEnabled,
    user?.scopes,
    ingressGroupsInPlan,
  ]);

  const contextActions = useMemo<PaletteEntry[]>(() => {
    const resource = activePageResource;
    const resourceRoute = resolvedPageRouteKey;
    if (!resource || !resourceRoute) return [];

    const actions: PaletteEntry[] = [];
    const nodeId = resource.nodeId;
    if (resource.resourceType === "docker-container" && nodeId) {
      const resourceSuffix = `${nodeId}/${resource.scopeResourceId ?? ""}`;
      if (
        hasScope("docker:containers:console") ||
        hasScope(`docker:containers:console:${resourceSuffix}`)
      ) {
        actions.push({
          id: "context:container-console",
          label: "Open container console",
          icon: Terminal,
          action: () =>
            window.open(
              `/docker/console/${nodeId}/${resource.resourceId}?shell=auto`,
              `console-${resource.resourceId}`,
              "width=900,height=600"
            ),
        });
      }
      if (
        hasScope("docker:containers:view") ||
        hasScope(`docker:containers:view:${resourceSuffix}`)
      ) {
        actions.push({
          id: "context:container-logs",
          label: "Open container logs",
          icon: ScrollText,
          action: () =>
            window.open(
              `/docker/logs/${nodeId}/${resource.resourceId}`,
              `logs-${resource.resourceId}`,
              "width=900,height=600"
            ),
        });
      }
      if (
        hasScope("docker:containers:files:read") ||
        hasScope(`docker:containers:files:read:${resourceSuffix}`)
      ) {
        actions.push({
          id: "context:container-files",
          label: "Browse container files",
          icon: FolderOpen,
          action: () => navigate(`${resourceRoute}/files`),
        });
      }
    }

    if (resource.resourceType === "docker-deployment" && nodeId) {
      if (hasScope(`docker:containers:view:${nodeId}/${resource.resourceId}`)) {
        actions.push({
          id: "context:deployment-logs",
          label: "Open deployment logs",
          icon: ScrollText,
          action: () =>
            window.open(
              `/docker/compose-logs/${nodeId}/${encodeURIComponent(resource.label ?? resource.resourceId)}`,
              `compose-logs-${resource.resourceId}`,
              "width=1000,height=700"
            ),
        });
      }
    }

    if (
      resource.resourceType === "docker-volume" &&
      nodeId &&
      (hasScope("docker:volumes:files:read") || hasScope(`docker:volumes:files:read:${nodeId}`))
    ) {
      actions.push({
        id: "context:volume-files",
        label: "Browse volume files",
        icon: FolderOpen,
        action: () => navigate(`${resourceRoute}/files`),
      });
    }

    // A protected relay offers no console or files: its machine owner locked Gateway out of the host.
    if (
      resource.resourceType === "node" &&
      !isNodeProtected(nodes.find((node) => node.id === resource.resourceId))
    ) {
      if (hasScope("nodes:console") || hasScope(`nodes:console:${resource.resourceId}`)) {
        actions.push({
          id: "context:node-console",
          label: "Open node console",
          icon: Terminal,
          action: () =>
            window.open(
              `/nodes/console/${resource.resourceId}?shell=auto`,
              `node-console-${resource.resourceId}`,
              "width=900,height=600"
            ),
        });
      }
      if (hasScope("nodes:files:read") || hasScope(`nodes:files:read:${resource.resourceId}`)) {
        actions.push({
          id: "context:node-files",
          label: "Browse node files",
          icon: FolderOpen,
          action: () => navigate(`${resourceRoute}/files`),
        });
      }
    }
    return actions;
  }, [activePageResource, hasScope, navigate, nodes, resolvedPageRouteKey]);

  const canCreateSslCertificate = hasCreationDestination(user?.scopes ?? [], "ssl:cert:issue");
  const primaryActions = useMemo<PaletteEntry[]>(() => {
    const actions: PaletteEntry[] = [
      {
        id: "action:toggle-sidebar",
        label: "Toggle sidebar",
        icon: PanelLeft,
        shortcut: "⌘J",
        action: toggleSidebar,
      },
    ];
    if (hasScopedAccess("proxy:create")) {
      actions.push({
        id: "action:new-proxy",
        label: "New route",
        contexts: ["proxy-hosts", "proxy-host"],
        icon: Plus,
        shortcut: "⌃H",
        action: () => navigate("/routes/new"),
      });
    }
    if (canCreateSslCertificate) {
      actions.push({
        id: "action:new-ssl",
        label: "New SSL certificate",
        contexts: ["ssl-certificates", "domains"],
        icon: Plus,
        shortcut: "⌃S",
        action: () => {
          navigate("/certificates");
          useUIStore.getState().openModal("createSSLCert");
        },
      });
    }
    if (pkiEnabled && hasScope("pki:ca:create:root")) {
      actions.push({
        id: "action:new-root-ca",
        label: "Create root CA",
        contexts: ["cas", "certificates", "templates"],
        icon: Plus,
        shortcut: "⌃R",
        action: () => {
          navigate("/certificates/authorities");
          useUIStore.getState().openModal("createCA");
        },
      });
    }
    actions.push({
      id: "action:open-ai",
      label: "Open AI Workspace",
      icon: Sparkles,
      action: () => {
        window.dispatchEvent(new CustomEvent("gateway:open-ai-workspace"));
      },
    });
    return actions;
  }, [canCreateSslCertificate, hasScope, hasScopedAccess, navigate, pkiEnabled, toggleSidebar]);

  const adaptiveQuickActions = useMemo(() => {
    const candidates = [...currentPageActions, ...contextActions, ...primaryActions].filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => candidate.id === entry.id) === index
    );
    const pageContexts = new Set([routeSection, quickActionContext]);

    const usageFor = (actionId: string) => {
      let contextCount = 0;
      let totalCount = 0;
      let lastUsedAt = 0;
      for (const usage of Object.values(commandActionUsage)) {
        if (usage.userId !== user?.id || usage.actionId !== actionId) continue;
        totalCount += usage.count;
        if (pageContexts.has(usage.context)) contextCount += usage.count;
        lastUsedAt = Math.max(lastUsedAt, usage.lastUsedAt);
      }
      return { contextCount, totalCount, lastUsedAt };
    };

    const ranked = candidates
      .map((entry, index) => {
        const usage = usageFor(entry.id);
        return {
          entry,
          index,
          relevant:
            currentPageActions.some((candidate) => candidate.id === entry.id) ||
            contextActions.some((candidate) => candidate.id === entry.id) ||
            entry.contexts?.some((context) => pageContexts.has(context)) === true,
          ...usage,
        };
      })
      .sort(
        (left, right) =>
          Number(right.relevant) - Number(left.relevant) ||
          right.contextCount - left.contextCount ||
          right.totalCount - left.totalCount ||
          right.lastUsedAt - left.lastUsedAt ||
          left.index - right.index
      );
    const contextual = ranked.filter(({ relevant, contextCount }) => relevant || contextCount > 0);
    return (routeSection === "dashboard" && contextual.length === 0 ? ranked : contextual)
      .slice(0, 5)
      .map(({ entry }) => entry);
  }, [
    commandActionUsage,
    contextActions,
    currentPageActions,
    primaryActions,
    quickActionContext,
    routeSection,
    user?.id,
  ]);

  const secondaryActions = useMemo<PaletteEntry[]>(
    () => [
      {
        id: "action:theme-light",
        label: "Light theme",
        detail: theme === "light" ? "Current theme" : undefined,
        icon: Sun,
        action: () => setTheme("light"),
      },
      {
        id: "action:theme-dark",
        label: "Dark theme",
        detail: theme === "dark" ? "Current theme" : undefined,
        icon: Moon,
        action: () => setTheme("dark"),
      },
      {
        id: "action:theme-system",
        label: "System theme",
        detail: theme === "system" ? "Current theme" : undefined,
        icon: Monitor,
        action: () => setTheme("system"),
      },
      {
        id: "action:logout",
        label: "Log out",
        icon: LogOut,
        action: handleLogout,
      },
    ],
    [handleLogout, setTheme, theme]
  );

  const entityCommands = useMemo<PaletteEntry[]>(() => {
    const entries: PaletteEntry[] = [];
    if (import.meta.env.DEV && hasScope("admin:update")) {
      const addUpdatePreview = (id: string, label: string, mode: "gateway" | "relay" | "both") => {
        entries.push({
          id,
          label,
          detail: "Development preview",
          keywords: ["dev update state"],
          icon: ArrowUpCircle,
          action: () => {
            setDevForcedUpdateMode(mode);
            void useUpdateStore.getState().fetchStatus();
            navigate("/settings/general");
          },
        });
      };
      addUpdatePreview("command:dev-update-gateway", "Show Opfield update only", "gateway");
      addUpdatePreview("command:dev-update-relay", "Show Relay update only", "relay");
      addUpdatePreview("command:dev-update-both", "Show Opfield and Relay updates", "both");
    }
    for (const container of commandContainers) {
      const nodeId = container._nodeId;
      if (!nodeId) continue;
      const resourceSuffix = `${nodeId}/${container.scopeResourceId ?? ""}`;
      const filesRoute = container._nodeSlug
        ? container.kind === "deployment"
          ? dockerDeploymentRoute(container._nodeSlug, container.name, "files")
          : dockerContainerRoute(container._nodeSlug, container.name, "files")
        : null;
      if (
        hasScope("docker:containers:console") ||
        hasScope(`docker:containers:console:${resourceSuffix}`)
      ) {
        entries.push({
          id: `command:container-console:${nodeId}:${container.id}`,
          label: `Console ${container.name}`,
          detail: `Open a shell in ${container.name}`,
          keywords: ["container terminal"],
          icon: Terminal,
          action: () =>
            window.open(
              `/docker/console/${nodeId}/${container.id}?shell=auto`,
              `console-${container.id}`,
              "width=900,height=600"
            ),
        });
      }
      if (
        hasScope("docker:containers:view") ||
        hasScope(`docker:containers:view:${resourceSuffix}`)
      ) {
        entries.push({
          id: `command:container-logs:${nodeId}:${container.id}`,
          label: `Logs ${container.name}`,
          detail: `Open logs for ${container.name}`,
          keywords: ["container"],
          icon: ScrollText,
          action: () =>
            window.open(
              `/docker/logs/${nodeId}/${container.id}`,
              `logs-${container.id}`,
              "width=900,height=600"
            ),
        });
      }
      if (
        filesRoute &&
        (hasScope("docker:containers:files:read") ||
          hasScope(`docker:containers:files:read:${resourceSuffix}`))
      ) {
        entries.push({
          id: `command:container-files:${nodeId}:${container.id}`,
          label: `Files ${container.name}`,
          detail: `Browse files in ${container.name}`,
          keywords: ["container"],
          icon: FolderOpen,
          action: () => navigate(filesRoute),
        });
      }
    }

    for (const node of nodes) {
      // A protected relay offers no console or files: its machine owner locked Gateway out of the host.
      if (isNodeProtected(node)) continue;
      if (
        node.status === "online" &&
        (hasScope("nodes:console") || hasScope(`nodes:console:${node.id}`))
      ) {
        const name = node.displayName || node.hostname;
        entries.push({
          id: `command:node-console:${node.id}`,
          label: `Console ${name}`,
          detail: `Open a shell on ${name}`,
          keywords: ["node terminal"],
          icon: Terminal,
          action: () =>
            window.open(
              `/nodes/console/${node.id}?shell=auto`,
              `node-console-${node.id}`,
              "width=900,height=600"
            ),
        });
      }
      if (hasScope("nodes:files:read") || hasScope(`nodes:files:read:${node.id}`)) {
        const name = node.displayName || node.hostname;
        entries.push({
          id: `command:node-files:${node.id}`,
          label: `Files ${name}`,
          detail: `Browse files on ${name}`,
          keywords: ["node"],
          icon: FolderOpen,
          action: () => navigate(nodeRoute(node.slug, "files")),
        });
      }
    }
    return entries;
  }, [commandContainers, hasScope, navigate, nodes]);

  const commandEntries = useMemo(() => {
    const entries = entityCommands;
    if (!commandQuery) return entries.slice(0, 50);
    return entries
      .map((entry) => ({ entry, score: entryScore(entry, commandQuery) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 50)
      .map(({ entry }) => entry);
  }, [commandQuery, entityCommands]);

  const filteredNavigation = useMemo(() => {
    if (!searchQuery) return baseNavigationEntries;
    return [...baseNavigationEntries, ...deepNavigationEntries]
      .map((entry) => ({ entry, score: entryScore(entry, searchQuery) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .map(({ entry }) => entry);
  }, [baseNavigationEntries, deepNavigationEntries, searchQuery]);

  const filteredActions = useMemo(() => {
    if (!searchQuery) return adaptiveQuickActions;
    return [...currentPageActions, ...contextActions, ...primaryActions, ...secondaryActions]
      .map((entry) => ({ entry, score: entryScore(entry, searchQuery) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .map(({ entry }) => entry);
  }, [
    adaptiveQuickActions,
    contextActions,
    currentPageActions,
    primaryActions,
    searchQuery,
    secondaryActions,
  ]);

  const hasSearchResults =
    resourceResults.length > 0 || filteredNavigation.length > 0 || filteredActions.length > 0;
  const askAIFallback = searchQuery.length > 0 && !hasSearchResults && aiScopeOk;
  const askAIQuotaExhausted = aiEnabled !== false && inferenceQuota.exhausted;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      onExitComplete={() => {
        setSearch("");
        setResourceResults([]);
        setResourceSearchPending(false);
      }}
      shouldFilter={false}
    >
      <CommandInput
        placeholder={isCommandMode ? "Type an action..." : "Search or type > for commands..."}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        {isCommandMode &&
          (commandEntries.length > 0 ? (
            <CommandGroup heading="Actions">
              {commandEntries.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  onSelect={() => handleSelect(entry.action)}
                >
                  <entry.icon className="mr-2 h-4 w-4" />
                  <span className="min-w-0 truncate">{entry.label}</span>
                  {entry.detail && (
                    <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
                      {entry.detail}
                    </span>
                  )}
                  {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : commandEntitiesPending ? (
            <CommandGroup heading="Actions">
              <CommandItem value="actions:loading" disabled>
                <Clock className="mr-2 h-4 w-4 animate-pulse" />
                Loading actions…
              </CommandItem>
            </CommandGroup>
          ) : (
            <CommandEmpty>No matching actions.</CommandEmpty>
          ))}

        {!isCommandMode && (
          <>
            {!searchQuery && adaptiveQuickActions.length > 0 && (
              <>
                <CommandGroup heading="Quick actions">
                  {adaptiveQuickActions.map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={entry.id}
                      disabled={entry.disabled}
                      onSelect={() => handleActionSelect(entry)}
                    >
                      {entry.iconNode ? (
                        <span className="mr-2 flex h-4 w-4 items-center justify-center [&_svg]:h-4 [&_svg]:w-4">
                          {entry.iconNode}
                        </span>
                      ) : (
                        <entry.icon className="mr-2 h-4 w-4" />
                      )}
                      {entry.label}
                      {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {!searchQuery && recentPages.length > 0 && (
              <>
                <CommandGroup heading="Recent">
                  {recentPages.slice(0, 5).map((page) => (
                    <CommandItem
                      key={page.path}
                      value={`recent:${page.path}`}
                      onSelect={() => handleSelect(() => navigate(page.path))}
                    >
                      <Clock className="mr-2 h-4 w-4 text-muted-foreground" />
                      <span className="truncate">{page.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {searchQuery && filteredNavigation.length > 0 && (
              <>
                <CommandGroup heading="Navigation">
                  {filteredNavigation.map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={entry.id}
                      onSelect={() => handleSelect(entry.action)}
                    >
                      <entry.icon className="mr-2 h-4 w-4" />
                      {entry.label}
                      {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
                {(resourceResults.length > 0 ||
                  resourceSearchPending ||
                  filteredActions.length > 0) && <CommandSeparator />}
              </>
            )}

            {searchQuery && (resourceResults.length > 0 || resourceSearchPending) && (
              <>
                <CommandGroup heading="Resources">
                  {resourceResults.map((result) => {
                    const Icon = resourceTypeIcon(result.type);
                    return (
                      <CommandItem
                        key={`${result.type}:${result.nodeId ?? ""}:${result.id}`}
                        value={`resource:${result.type}:${result.id}`}
                        onSelect={() => handleSelect(() => navigate(resourceSearchHref(result)))}
                      >
                        <Icon className="mr-2 h-4 w-4" />
                        <span className="min-w-0 truncate">{result.name}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {resourceSearchSecondaryText(result)}
                        </span>
                      </CommandItem>
                    );
                  })}
                  {resourceSearchPending && resourceResults.length === 0 && (
                    <CommandItem value="resources:loading" disabled>
                      <Clock className="mr-2 h-4 w-4 animate-pulse" />
                      Searching resources…
                    </CommandItem>
                  )}
                </CommandGroup>
                {filteredActions.length > 0 && <CommandSeparator />}
              </>
            )}

            {searchQuery && filteredActions.length > 0 && (
              <CommandGroup heading="Actions">
                {filteredActions.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    disabled={entry.disabled}
                    onSelect={() => handleActionSelect(entry)}
                  >
                    {entry.iconNode ? (
                      <span className="mr-2 flex h-4 w-4 items-center justify-center [&_svg]:h-4 [&_svg]:w-4">
                        {entry.iconNode}
                      </span>
                    ) : (
                      <entry.icon className="mr-2 h-4 w-4" />
                    )}
                    {entry.label}
                    {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!searchQuery && filteredNavigation.length > 0 && (
              <CommandGroup heading="Navigation">
                {filteredNavigation.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => handleSelect(entry.action)}
                  >
                    <entry.icon className="mr-2 h-4 w-4" />
                    {entry.label}
                    {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!searchQuery && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Theme">
                  {secondaryActions.slice(0, 3).map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={entry.id}
                      onSelect={() => handleSelect(entry.action)}
                    >
                      <entry.icon className="mr-2 h-4 w-4" />
                      {entry.label.replace(/^Use /, "").replace(/ theme$/, "")}
                      {entry.detail && <CommandShortcut>✓</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Account">
                  <CommandItem value="action:logout" onSelect={() => handleSelect(handleLogout)}>
                    <LogOut className="mr-2 h-4 w-4" />
                    Log out
                  </CommandItem>
                </CommandGroup>
              </>
            )}

            {askAIFallback && (
              <CommandGroup heading={`Nothing matches “${searchQuery}”`}>
                <CommandItem
                  value="ask-ai"
                  disabled={askAIQuotaExhausted}
                  onSelect={() => handleSelect(() => handleAskAI(searchQuery))}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  Ask AI: "{searchQuery}"
                  {askAIQuotaExhausted && (
                    <span className="ml-auto text-xs text-muted-foreground">Quota exhausted</span>
                  )}
                </CommandItem>
              </CommandGroup>
            )}

            {!searchQuery && filteredNavigation.length === 0 && filteredActions.length === 0 && (
              <CommandEmpty>No available pages or actions.</CommandEmpty>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
