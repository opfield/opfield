import { Menu } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AIButton } from "@/components/ai/AIButton";
import { AILitePanel } from "@/components/ai/AILitePanel";
import { AILiteSidebar } from "@/components/ai/AILiteSidebar";
import { AISidePanel } from "@/components/ai/AISidePanel";
import {
  type AIWorkspaceAvailability,
  AIWorkspaceAvailabilityDialog,
} from "@/components/ai/AIWorkspaceAvailabilityDialog";
import { InterfaceChoiceDialog } from "@/components/ai/InterfaceChoiceDialog";
import { CommandPalette } from "@/components/common/CommandPalette";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { PageTransition } from "@/components/common/PageTransition";
import { DemoModeDialog } from "@/components/demo/DemoModeDialog";
import { LicenseUpgradeDialog } from "@/components/license/LicenseUpgradeDialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRouteScrollRestoration } from "@/hooks/use-route-scroll-restoration";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { getLoginRedirectUrl } from "@/lib/auth-return-to";
import { applyForcedGatewayUpdateStatus } from "@/lib/dev-force-updates";
import { isCompactPanelsViewport } from "@/lib/responsive-panels";
import { ConfigureAIWorkspaceWizard } from "@/pages/dashboard/finalize-setup/ConfigureAIWorkspaceWizard";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import type { BackgroundPrewarmTask } from "@/services/background-prewarm";
import { useAIStore } from "@/stores/ai";
import { accessContextKey, useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useDockerStore } from "@/stores/docker";
import { useDockerFolderStore } from "@/stores/docker-folders";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { useUpdateStore } from "@/stores/update";
import { AI_SCOPE } from "@/types";
import {
  ApplicationShellSkeleton,
  persistSidebarWidth,
  readSidebarWidth,
  registerCommandPaletteShiftPress,
  resolveAccessibleInterface,
  resolveAIWorkspaceEntry,
  resolveInterfaceTransition,
  shouldOpenAIConversationInConsole,
} from "./dashboard-layout-helpers";
import { SidebarContent } from "./SidebarContent";

export function DashboardLayout() {
  const navigate = useStableNavigate();
  const loginRedirectUrl = useRef(getLoginRedirectUrl()).current;
  const { isAuthenticated, isLoading, setUser, setLoading, logout } = useAuthStore();
  const currentUser = useAuthStore((state) => state.user);
  // Remount page content when access narrows or the user changes, not when live scopes widen.
  const contentAccessKey = useAuthStore(accessContextKey);
  const authAccessKey = currentUser
    ? `${currentUser.id}\u0000${[...currentUser.scopes].sort().join("\u0000")}`
    : null;
  const {
    isMobile,
    setIsMobile,
    mobileMenuOpen,
    setMobileMenuOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
    aiLiteMode,
    preferredInterface,
    interfacePreferenceLoaded,
    setPreferredInterface,
  } = useUIStore();
  const aiEnabled = useAIStore((state) => state.isEnabled);

  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [interfaceChoiceBusy, setInterfaceChoiceBusy] = useState(false);
  const interfacePreferenceSavePendingRef = useRef(false);
  const [interfaceChoiceDismissed, setInterfaceChoiceDismissed] = useState(false);
  const [interfaceSetupOrigin, setInterfaceSetupOrigin] = useState<
    "interface_choice" | "cta" | null
  >(null);
  const [aiWorkspaceAvailability, setAIWorkspaceAvailability] =
    useState<AIWorkspaceAvailability | null>(null);
  const setSystemConfig = useSystemConfigStore((state) => state.setConfig);
  const [systemConfigReady, setSystemConfigReady] = useState(false);
  const uiBootstrap = useUIBootstrapStore((state) => state.snapshot);
  const loadUIBootstrap = useUIBootstrapStore((state) => state.load);
  const invalidateUIBootstrap = useUIBootstrapStore((state) => state.invalidate);
  const clearUIBootstrap = useUIBootstrapStore((state) => state.clear);
  const hasNginxNodes = uiBootstrap?.navigation.hasNginxNodes ?? true;
  const canUseAIWorkspace = Boolean(currentUser?.scopes?.includes(AI_SCOPE));
  const canConfigureAIWorkspace = Boolean(currentUser?.scopes?.includes("feat:ai:configure"));
  const canConfigureGatewayInference = [
    "settings:gateway:edit",
    "inference:providers:view",
    "inference:providers:manage",
    "inference:models:manage",
    "inference:limits:manage",
  ].every((scope) => currentUser?.scopes?.includes(scope));
  const aiWorkspaceConfigured = uiBootstrap?.aiWorkspace.configured ?? false;
  const interfaceChoiceRequired = Boolean(
    interfacePreferenceLoaded &&
      !interfaceChoiceDismissed &&
      preferredInterface === null &&
      uiBootstrap &&
      canUseAIWorkspace &&
      (aiWorkspaceConfigured || uiBootstrap.aiWorkspace.installationOwner)
  );

  const savePreferredInterface = useCallback(
    async (
      nextInterface: "ai_workspace" | "operations_console",
      preserveConversationInConsole = false
    ) => {
      if (interfacePreferenceSavePendingRef.current) return;
      interfacePreferenceSavePendingRef.current = true;
      setInterfaceChoiceBusy(true);
      try {
        await api.updateUserPreferences({ preferredInterface: nextInterface });
        setPreferredInterface(nextInterface);
        setInterfaceChoiceDismissed(true);
        const transition = resolveInterfaceTransition(nextInterface, preserveConversationInConsole);
        if (transition.aiPanelOpen !== null)
          useUIStore.getState().setAIPanelOpen(transition.aiPanelOpen);
        if (transition.path) navigate(transition.path);
      } finally {
        interfacePreferenceSavePendingRef.current = false;
        setInterfaceChoiceBusy(false);
      }
    },
    [navigate, setPreferredInterface]
  );

  const finishInterfaceSetup = useCallback(async () => {
    setInterfaceChoiceBusy(true);
    try {
      try {
        await api.updateFinalizeSetupStep("ai_workspace", "configured");
      } catch (cause) {
        if (!(cause instanceof ApiRequestError) || ![404, 409].includes(cause.status)) throw cause;
      }
      await useAIStore.getState().refreshProviderStatus();
      invalidateUIBootstrap();
      setInterfaceSetupOrigin(null);
      await savePreferredInterface("ai_workspace");
    } finally {
      setInterfaceChoiceBusy(false);
    }
  }, [invalidateUIBootstrap, savePreferredInterface]);

  const interfaceSetupOpen = interfaceSetupOrigin !== null;

  useEffect(() => {
    const openAIWorkspace = () => {
      const entry = resolveAIWorkspaceEntry(
        aiWorkspaceConfigured,
        canUseAIWorkspace,
        canConfigureAIWorkspace,
        aiEnabled
      );
      if (entry === "open") {
        void savePreferredInterface("ai_workspace");
        return;
      }
      if (entry === "needs_configuration") useUIStore.getState().setAILiteMode(false);
      setAIWorkspaceAvailability(entry);
    };
    const openOperationsConsole = () => {
      const ai = useAIStore.getState();
      void savePreferredInterface(
        "operations_console",
        shouldOpenAIConversationInConsole(ai.activeConversationId, ai.messages)
      );
    };
    window.addEventListener("gateway:open-ai-workspace", openAIWorkspace);
    window.addEventListener("gateway:open-operations-console", openOperationsConsole);
    return () => {
      window.removeEventListener("gateway:open-ai-workspace", openAIWorkspace);
      window.removeEventListener("gateway:open-operations-console", openOperationsConsole);
    };
  }, [
    aiEnabled,
    aiWorkspaceConfigured,
    canConfigureAIWorkspace,
    canUseAIWorkspace,
    savePreferredInterface,
  ]);

  useEffect(() => {
    if (!interfacePreferenceLoaded || !uiBootstrap) return;
    const accessibleInterface = resolveAccessibleInterface(preferredInterface, canUseAIWorkspace);
    if (accessibleInterface === preferredInterface || accessibleInterface === null) return;

    setPreferredInterface(accessibleInterface);
    setInterfaceChoiceDismissed(true);
    void api
      .updateUserPreferences({ preferredInterface: accessibleInterface })
      .catch(() => undefined);
  }, [
    canUseAIWorkspace,
    interfacePreferenceLoaded,
    preferredInterface,
    setPreferredInterface,
    uiBootstrap,
  ]);

  // Project each refreshed shell atomically into the existing feature stores.
  // The layout must subscribe to the store as well as await the first load so
  // realtime invalidations update navigation without a full page reload.
  useEffect(() => {
    if (!uiBootstrap) return;
    setSystemConfig(uiBootstrap.systemConfig);
    useDockerStore.getState().setDockerNodes(uiBootstrap.navigation.dockerNodes);
    if (uiBootstrap.update) {
      useUpdateStore.setState({ status: applyForcedGatewayUpdateStatus(uiBootstrap.update) });
    }
    if (uiBootstrap.aiStatus) useAIStore.getState().setProviderStatus(uiBootstrap.aiStatus);
  }, [setSystemConfig, uiBootstrap]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") invalidateUIBootstrap();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [invalidateUIBootstrap, isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) return;
    clearUIBootstrap();
  }, [clearUIBootstrap, isAuthenticated]);

  const handleSidebarResize = useCallback((width: number) => {
    setSidebarWidth(width);
  }, []);

  const handleResizeStart = useCallback(() => {
    setIsResizing(true);
  }, []);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    setSidebarWidth((w) => {
      persistSidebarWidth(w);
      return w;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const prewarmController = new AbortController();

    const checkAuth = async () => {
      try {
        const existingUser = useAuthStore.getState().user;
        const user = existingUser ?? (await api.getCurrentUser());
        if (cancelled) return;
        if (user.isBlocked && !user.impersonation?.active) {
          setUser(user);
          setLoading(false);
          navigate("/blocked");
          return;
        }
        if (!existingUser) setUser(user);
        // Durable route caches are namespaced by the same identity and sorted
        // access set that the backend uses for its UI access fingerprint.
        await api.hydratePersistentCache(
          authAccessKey ?? `${user.id}\u0000${[...user.scopes].sort().join("\u0000")}`
        );
        if (cancelled) return;
        // Scopes are now known. The shell can render permission-safe skeleton
        // geometry while its read model fills in, rather than retaining the
        // anonymous loading state for a database/cache request.
        setLoading(false);
        const shell = await loadUIBootstrap(`${user.id}:${[...user.scopes].sort().join("|")}`);
        if (cancelled) return;
        // Do not let a durable but stale feature snapshot mount protected
        // routes before the current shell request settles. That otherwise
        // produces transient FEATURE_DISABLED requests after a feature toggle.
        if (shell) setSystemConfig(shell.systemConfig);
        setSystemConfigReady(true);
        const hasAdminScopes = user.scopes.some((scope) => scope.startsWith("admin:"));
        const docker = useDockerStore.getState();
        const dockerFolders = useDockerFolderStore.getState();
        const extraTasks: BackgroundPrewarmTask[] = [];
        const addDockerTask = (allowed: boolean, key: string, run: () => Promise<unknown>) => {
          if (allowed) extraTasks.push({ key, run });
        };
        addDockerTask(
          useAuthStore.getState().hasScopedAccess("docker:containers:view"),
          "docker-container-folders",
          () => dockerFolders.fetchFolders("container")
        );
        addDockerTask(
          useAuthStore.getState().hasScopedAccess("docker:containers:view"),
          "docker-containers",
          () => docker.fetchContainers(null, "", shell?.navigation.dockerNodes)
        );
        addDockerTask(
          useAuthStore.getState().hasScopedAccess("docker:images:view"),
          "docker-image-folders",
          () => dockerFolders.fetchFolders("image")
        );
        addDockerTask(
          useAuthStore.getState().hasScopedAccess("docker:images:view"),
          "docker-images",
          () => docker.fetchImages(null, "", shell?.navigation.dockerNodes)
        );
        addDockerTask(
          useAuthStore.getState().hasScopedAccess("docker:volumes:view"),
          "docker-volume-folders",
          () => dockerFolders.fetchFolders("volume")
        );
        addDockerTask(
          useAuthStore.getState().hasScopedAccess("docker:volumes:view"),
          "docker-volumes",
          () => docker.fetchVolumes(null, "", shell?.navigation.dockerNodes)
        );
        addDockerTask(
          useAuthStore.getState().hasScopedAccess("docker:networks:view"),
          "docker-network-folders",
          () => dockerFolders.fetchFolders("network")
        );
        addDockerTask(
          useAuthStore.getState().hasScopedAccess("docker:networks:view"),
          "docker-networks",
          () => docker.fetchNetworks(null, "", shell?.navigation.dockerNodes)
        );
        addDockerTask(useAuthStore.getState().hasScopedAccess("docker:tasks"), "docker-tasks", () =>
          docker.fetchTasks(null)
        );
        void api.prefetchAll(hasAdminScopes, prewarmController.signal, extraTasks);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) {
          logout();
          navigate(loginRedirectUrl);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void checkAuth();
    return () => {
      cancelled = true;
      prewarmController.abort();
    };
  }, [
    authAccessKey,
    loadUIBootstrap,
    loginRedirectUrl,
    logout,
    navigate,
    setLoading,
    setSystemConfig,
    setUser,
  ]);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
      const ui = useUIStore.getState();
      if (isCompactPanelsViewport(window.innerWidth) && ui.aiPanelOpen && ui.sidebarOpen) {
        ui.setSidebarCollapsed(true);
      }
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, [setIsMobile]);

  // Track recent pages for command palette
  const location = useLocation();
  useRouteScrollRestoration(currentUser?.id);
  useEffect(() => {
    if (!isMobile || !location.pathname) return;
    setMobileMenuOpen(false);
  }, [isMobile, location.pathname, setMobileMenuOpen]);
  const resolvedPageStatus = useResolvedPageContext((s) => s.status);
  const resolvedPageRouteKey = useResolvedPageContext((s) => s.routeKey);
  const resolvedPageResource = useResolvedPageContext((s) => s.resource);
  useEffect(() => {
    const path = location.pathname;
    if (path === "/" || path === "/login" || path === "/callback" || path === "/blocked") return;

    const resolvedDetailPath =
      /^\/(?:nodes|databases|proxy-hosts)\/[^/]+/.test(path) ||
      /^\/logging\/(?:environments|schemas)\/[^/]+/.test(path) ||
      /^\/docker\/(?:containers|deployments|volumes)\/[^/]+\/[^/]+/.test(path);
    if (resolvedDetailPath) {
      const ownsRoute =
        resolvedPageStatus === "ready" &&
        resolvedPageRouteKey &&
        (path === resolvedPageRouteKey || path.startsWith(`${resolvedPageRouteKey}/`));
      if (!ownsRoute || !resolvedPageResource) return;

      const segments = path.split("/");
      const decode = (value: string | undefined) => {
        if (!value) return "";
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };
      const tab = resolvedPageResource.resourceType.startsWith("docker-")
        ? decode(segments[5])
        : resolvedPageResource.resourceType.startsWith("logging-")
          ? decode(segments[4])
          : decode(segments[3]);
      const identity = resolvedPageResource.resourceType.startsWith("docker-")
        ? decode(segments[4])
        : resolvedPageResource.resourceType.startsWith("logging-")
          ? decode(segments[3])
          : decode(segments[2]);
      const prefix =
        resolvedPageResource.resourceType === "node"
          ? "Node"
          : resolvedPageResource.resourceType === "database"
            ? "Database"
            : resolvedPageResource.resourceType === "proxy-host"
              ? "Proxy"
              : resolvedPageResource.resourceType === "logging-environment"
                ? "Log environment"
                : resolvedPageResource.resourceType === "logging-schema"
                  ? "Log schema"
                  : resolvedPageResource.resourceType === "docker-container"
                    ? "Container"
                    : resolvedPageResource.resourceType === "docker-deployment"
                      ? "Deployment"
                      : "Volume";
      const formattedTab = tab
        ? ` / ${tab.charAt(0).toUpperCase() + tab.slice(1).replace(/-/g, " ")}`
        : "";
      const resourceKey = [
        resolvedPageResource.resourceType,
        resolvedPageResource.nodeId,
        resolvedPageResource.resourceId,
      ]
        .filter(Boolean)
        .join(":");
      useUIStore
        .getState()
        .addRecentPage(
          path,
          `${prefix}: ${resolvedPageResource.label || identity}${formattedTab}`,
          undefined,
          resourceKey
        );
      return;
    }

    // Build a human-readable label for ID-based and section routes.
    const label = (() => {
      // CA detail: /cas/:id
      const caMatch = path.match(/^\/cas\/([0-9a-f-]{36})/);
      if (caMatch) {
        const ca = useCAStore.getState().cas?.find((c) => c.id === caMatch[1]);
        return ca ? `CA: ${ca.commonName}` : `CA: ${caMatch[1].slice(0, 8)}`;
      }
      // Nginx template detail: /nginx-templates/:id
      const templateMatch = path.match(/^\/nginx-templates\/([0-9a-f-]{36})/);
      if (templateMatch) {
        api
          .getNginxTemplate(templateMatch[1])
          .then((template) => {
            const resolvedLabel = `Template: ${template.name}`;
            useUIStore.getState().addRecentPage(path, resolvedLabel);
          })
          .catch(() => {});
        return `Template: ${templateMatch[1].slice(0, 8)}`;
      }
      // Generic: prettify path segments
      const segments = path.split("/").filter(Boolean);
      return segments
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" / ")
        .replace(/-/g, " ");
    })();

    useUIStore.getState().addRecentPage(path, label);
  }, [location.pathname, resolvedPageResource, resolvedPageRouteKey, resolvedPageStatus]);

  // Keyboard shortcuts
  useEffect(() => {
    let shiftState = { count: 0, lastPressAt: 0 };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const next = registerCommandPaletteShiftPress(shiftState, Date.now());
        shiftState = next.state;
        if (next.open) setCommandPaletteOpen(true);
        return;
      }
      shiftState = { count: 0, lastPressAt: 0 };
    };
    window.addEventListener("keyup", handleKeyUp);

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
      if (mod && e.key === "j") {
        e.preventDefault();
        useUIStore.getState().toggleSidebar();
      }
      if (mod && e.key === "i") {
        e.preventDefault();
        const { hasScope: checkScope } = useAuthStore.getState();
        const aiEnabled = useAIStore.getState().isEnabled;
        if (checkScope(AI_SCOPE) && aiEnabled !== false) {
          const ui = useUIStore.getState();
          if (ui.aiLiteMode) {
            ui.setAILiteMode(false);
          } else {
            ui.toggleAIPanel();
          }
        }
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        navigate("/settings");
      }
      // Ctrl+H = new proxy host, Ctrl+S = new SSL cert, Ctrl+R = new root CA
      if (e.ctrlKey && !e.metaKey && !e.altKey) {
        const features = useSystemConfigStore.getState().config.features;
        switch (e.key) {
          case "h":
            e.preventDefault();
            navigate("/proxy-hosts/new");
            break;
          case "s":
            e.preventDefault();
            navigate("/ssl-certificates");
            useUIStore.getState().openModal("createSSLCert");
            break;
          case "r":
            e.preventDefault();
            if (!features.pkiEnabled) break;
            navigate("/cas");
            useUIStore.getState().openModal("createCA");
            break;
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [commandPaletteOpen, setCommandPaletteOpen, navigate]);

  const interfaceOnboarding = (
    <>
      <InterfaceChoiceDialog
        open={interfaceChoiceRequired && !interfaceSetupOpen}
        busy={interfaceChoiceBusy}
        onAIWorkspace={() => {
          if (aiWorkspaceConfigured) void savePreferredInterface("ai_workspace");
          else setInterfaceSetupOrigin("interface_choice");
        }}
        onOperationsConsole={() => void savePreferredInterface("operations_console")}
      />
      <ConfigureAIWorkspaceWizard
        open={interfaceSetupOpen}
        allowGatewayInference={canConfigureGatewayInference}
        initialStepCanSkip={interfaceSetupOrigin !== "interface_choice"}
        completionActionLabel={
          interfaceSetupOrigin === "interface_choice" ? "Enable AI Workspace" : "Open AI Workspace"
        }
        onBack={() => setInterfaceSetupOrigin(null)}
        onConfigured={() => finishInterfaceSetup()}
        onSkipped={async () => setInterfaceSetupOrigin(null)}
      />
      <AIWorkspaceAvailabilityDialog
        state={aiWorkspaceAvailability}
        onClose={() => setAIWorkspaceAvailability(null)}
        onConfigure={() => {
          setAIWorkspaceAvailability(null);
          setInterfaceSetupOrigin("cta");
        }}
      />
      <LicenseUpgradeDialog />
      <DemoModeDialog />
    </>
  );

  if (isLoading || !systemConfigReady) {
    return <ApplicationShellSkeleton />;
  }

  if (!isAuthenticated) {
    return null;
  }

  const canUseAI = !!currentUser?.scopes?.includes(AI_SCOPE) && aiEnabled !== false;
  const isAIConversationRoute = /^\/ai\/chats\/[^/]+$/.test(location.pathname);
  const isAIHome = location.pathname === "/" || isAIConversationRoute;
  if (canUseAI && isAIHome && !interfacePreferenceLoaded) {
    return <ApplicationShellSkeleton label="Loading workspace" />;
  }

  const useLiteMode =
    interfacePreferenceLoaded && (aiLiteMode || isAIConversationRoute) && canUseAI;

  if (isMobile && useLiteMode && isAIHome) {
    return (
      <TooltipProvider>
        <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
          <PageTransition>
            <AILitePanel key={contentAccessKey} onOpenMobileMenu={() => setMobileMenuOpen(true)} />
          </PageTransition>
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetContent side="left" className="w-full p-0" hideCloseButton>
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <AILiteSidebar alwaysExpanded mobileMenu onClose={() => setMobileMenuOpen(false)} />
            </SheetContent>
          </Sheet>
          <Toaster position="bottom-center" />
          <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
          <ConfirmDialog />
          {interfaceOnboarding}
        </div>
      </TooltipProvider>
    );
  }

  if (isMobile) {
    return (
      <TooltipProvider>
        <div className="@container/page fixed inset-0 flex flex-col overflow-hidden bg-background">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-2">
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open navigation"
                onClick={() => setMobileMenuOpen(true)}
              >
                <Menu className="h-5 w-5" />
              </Button>
              <span className="ml-2 flex items-center gap-1.5 text-sm font-semibold">
                <img src="/android-chrome-192x192.png" alt="Gateway" className="h-5 w-5" />
                Gateway
              </span>
              <div className="ml-2">
                <AIButton />
              </div>
            </div>
          </header>

          <div data-page-content className="flex-1 overflow-hidden">
            <Outlet key={contentAccessKey} />
          </div>

          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetContent side="left" className="w-full p-0" hideCloseButton>
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <SidebarContent
                onNavigate={() => setMobileMenuOpen(false)}
                alwaysExpanded
                hasNginxNodes={hasNginxNodes}
              />
            </SheetContent>
          </Sheet>

          <AISidePanel isMobile />
          <Toaster position="bottom-center" />
          <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
          <ConfirmDialog />
          {interfaceOnboarding}
        </div>
      </TooltipProvider>
    );
  }

  if (useLiteMode) {
    return (
      <TooltipProvider>
        <div className="@container/page fixed inset-0 flex overflow-hidden bg-background dashboard-scrollbar">
          <div className="ai-chat-content-fade-in flex h-full shrink-0">
            <AILiteSidebar
              sidebarWidth={sidebarWidth}
              onSidebarWidthChange={handleSidebarResize}
              isResizing={isResizing}
              onResizeStart={handleResizeStart}
              onResizeEnd={handleResizeEnd}
            />
          </div>
          <main data-page-content className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            {isAIHome ? (
              <PageTransition>
                <AILitePanel key={contentAccessKey} />
              </PageTransition>
            ) : (
              <Outlet key={contentAccessKey} />
            )}
          </main>
          <Toaster position="bottom-right" />
          <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
          <ConfirmDialog />
          {interfaceOnboarding}
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="fixed inset-0 flex min-w-0 overflow-hidden bg-background dashboard-scrollbar">
        {/* The page's breakpoints measure this box, the window without the docked AI panel, so a
            page lays out for the width it really gets (see index.css). */}
        <div className="@container/page flex h-full min-w-0 flex-1">
          <SidebarContent
            sidebarWidth={sidebarWidth}
            onSidebarWidthChange={handleSidebarResize}
            isResizing={isResizing}
            onResizeStart={handleResizeStart}
            onResizeEnd={handleResizeEnd}
            hasNginxNodes={hasNginxNodes}
          />
          <main data-page-content className="h-full min-w-0 flex-1 overflow-hidden">
            <Outlet key={contentAccessKey} />
          </main>
        </div>
        <AISidePanel />
        <Toaster position="bottom-right" />
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
        <ConfirmDialog />
        {interfaceOnboarding}
      </div>
    </TooltipProvider>
  );
}
