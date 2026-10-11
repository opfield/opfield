import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpCircle,
  PanelLeft,
  PanelLeftClose,
  RotateCw,
  Search,
  UserRoundX,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AIButton } from "@/components/ai/AIButton";
import { AccountMenuContent } from "@/components/layout/AccountMenuContent";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLoadDashboardBootstrap } from "@/hooks/use-dashboard-bootstrap";
import { visibleNavigationGroups } from "@/lib/app-navigation";
import { hasLowInferenceUsage } from "@/lib/inference-self-usage";
import { isSidebarNavigationActive } from "@/lib/sidebar-navigation";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { useDockerStore } from "@/stores/docker";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { useUpdateStore } from "@/stores/update";
import { dashboardAttentionDotClass, dashboardAttentionLabel } from "./dashboard-attention";
import { navigationAttentionForItem, navigationAttentionLabel } from "./navigation-attention";
import { SidebarPinnedResources } from "./SidebarPinnedResources";
import { SIDEBAR_ITEM_FADE, SIDEBAR_ITEM_FILL, SIDEBAR_ITEM_HOVER_FILL } from "./sidebar-item-fill";

function getInitials(name: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const RELAY_UPDATE_STATUS_CHECK_INTERVAL_MS = 15_000;

/**
 * The label of a running Relay Pool update, or null. The update never blocks the app: the sidebar shows this and
 * links to Settings > Relay, which shows the progress and can abandon a stuck update.
 */
function useRelayPoolUpdateLabel(): string | null {
  const active = useUpdateStore(
    (state) =>
      (state.isUpdating && state.updatingComponent === "relay") ||
      state.status?.relay.operation?.status === "updating"
  );
  const targetVersion = useUpdateStore(
    (state) =>
      state.status?.relay.operation?.targetVersion ??
      state.updatingTargetVersion ??
      state.status?.relay.latestVersion ??
      null
  );
  useEffect(() => {
    if (!active) return;
    // Re-read the status so the indicator clears once the update finishes, even without its event.
    const timer = window.setInterval(() => {
      void useUpdateStore.getState().fetchStatus();
    }, RELAY_UPDATE_STATUS_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!active) return null;
  return targetVersion ? `Relay Pool is updating to ${targetVersion}` : "Relay Pool is updating";
}

const RELAY_UPDATE_ICON_CLASS = "animate-spin motion-reduce:[animation-duration:1.8s]";

export interface SidebarContentProps {
  onNavigate?: () => void;
  alwaysExpanded?: boolean;
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  isResizing?: boolean;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  hasNginxNodes?: boolean;
}

export function SidebarContent({
  onNavigate,
  alwaysExpanded = false,
  sidebarWidth = 260,
  onSidebarWidthChange,
  isResizing = false,
  onResizeStart,
  onResizeEnd,
  hasNginxNodes = true,
}: SidebarContentProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, hasScope, hasScopedAccess, logout } = useAuthStore();
  const [stoppingImpersonation, setStoppingImpersonation] = useState(false);
  const { sidebarOpen, toggleSidebar, setCommandPaletteOpen: openPalette } = useUIStore();

  const updateStatus = useUpdateStore((s) => s.status);
  const gatewayUpdateAvailable = updateStatus?.updateAvailable ?? false;
  // A running Relay Pool rollout shows its own indicator, not another update offer.
  const relayOnlyUpdateAvailable =
    !gatewayUpdateAvailable &&
    (updateStatus?.relay?.updateAvailable ?? false) &&
    updateStatus?.relay?.operation?.status !== "updating";
  const updateAvailable = gatewayUpdateAvailable || relayOnlyUpdateAvailable;
  const updateLabel = relayOnlyUpdateAvailable
    ? "Relay update available"
    : "Gateway update available";
  const showUpdateNotifications = useUIStore((s) => s.showUpdateNotifications);
  const relayUpdateLabel = useRelayPoolUpdateLabel();
  const showRelayUpdate = relayUpdateLabel !== null && hasScope("settings:gateway:view");
  const statusPageEnabled = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.statusPageEnabled ?? false
  );
  const pagesEnabled = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.pagesEnabled ?? false
  );
  const hasCloudflareIntegration = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.hasCloudflareIntegration ?? false
  );
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const siemEnabled = useSystemConfigStore((s) => s.config.features.siemEnabled);
  const loggingEnabled = useSystemConfigStore((s) => s.config.features.loggingEnabled);
  const inferenceEnabled = useSystemConfigStore((s) => s.config.features.inferenceEnabled);

  const dockerNodes = useDockerStore((s) => s.dockerNodes);
  const dashboardBootstrap = useDashboardBootstrapStore((s) => s.snapshot);
  useLoadDashboardBootstrap();

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      logout();
    }
    navigate("/login");
  };

  const handleStopImpersonating = async () => {
    setStoppingImpersonation(true);
    try {
      await api.stopImpersonating();
      api.resetSessionState();
      window.location.assign("/");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to stop impersonating");
      setStoppingImpersonation(false);
    }
  };

  const isExpanded = alwaysExpanded || sidebarOpen;

  const effectiveGroups = visibleNavigationGroups({
    scopes: user?.scopes ?? [],
    pkiEnabled,
    siemEnabled,
    loggingEnabled,
    inferenceEnabled,
    hasLowInferenceUsage: hasLowInferenceUsage(dashboardBootstrap?.inferenceUsage ?? null),
    statusPageEnabled,
    pagesEnabled,
    hasCloudflareIntegration,
    hasNginxNodes,
    hasDockerNodes:
      dockerNodes.length > 0 ||
      [
        "docker:containers:view",
        "docker:images:view",
        "docker:volumes:view",
        "docker:networks:view",
      ].some(hasScopedAccess),
  });

  const allNavItems = effectiveGroups.flatMap((g) => g.items);
  const dashboardAttention = dashboardBootstrap?.attention.severity ?? null;

  return (
    <div
      style={{
        width: alwaysExpanded ? "100%" : isExpanded ? sidebarWidth : 48,
      }}
      className={cn(
        "relative flex h-full shrink-0 flex-col bg-sidebar-background overflow-visible",
        !alwaysExpanded && "border-r border-sidebar-border",
        !alwaysExpanded && !isResizing && "transition-[width] duration-200 ease-out"
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        {!isExpanded ? (
          <motion.div
            key="collapsed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-y-0 left-0 flex w-12 flex-col items-center gap-2 py-3"
          >
            <TooltipProvider delayDuration={0} skipDelayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Open sidebar"
                    onClick={toggleSidebar}
                  >
                    <PanelLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Open sidebar</TooltipContent>
              </Tooltip>

              {allNavItems.map((item) => {
                const navigationAttention = navigationAttentionForItem(dashboardBootstrap, item.id);
                return (
                  <Tooltip key={item.href}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={item.name}
                        className={cn(
                          // The button's own hover stays; the active fill fades like the expanded items'.
                          "transition-[color,background-color,box-shadow] shadow-[inset_0_0_0_100vmax_transparent]",
                          isSidebarNavigationActive(location.pathname, item.href) &&
                            SIDEBAR_ITEM_FILL
                        )}
                        onClick={() => navigate(item.href)}
                      >
                        <span className="relative flex">
                          <item.icon className="h-4 w-4" />
                          {item.id === "dashboard" && dashboardAttention && (
                            <span
                              aria-label={dashboardAttentionLabel(dashboardAttention)}
                              className={cn(
                                "absolute -right-2 -top-2 h-2 w-2",
                                dashboardAttentionDotClass(dashboardAttention)
                              )}
                            />
                          )}
                          {navigationAttention && (
                            <span
                              aria-label={navigationAttentionLabel(item.id, navigationAttention)}
                              className={cn(
                                "absolute -right-2 -top-2 h-2 w-2",
                                dashboardAttentionDotClass(navigationAttention)
                              )}
                            />
                          )}
                        </span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{item.name}</TooltipContent>
                  </Tooltip>
                );
              })}

              <div className="flex-1" />

              <AIButton iconOnly />

              {showRelayUpdate && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      aria-label={relayUpdateLabel}
                      onClick={() => navigate("/settings/relay")}
                    >
                      <RotateCw className={cn("h-4 w-4", RELAY_UPDATE_ICON_CLASS)} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">{relayUpdateLabel}</TooltipContent>
                </Tooltip>
              )}

              {updateAvailable && hasScope("admin:update") && showUpdateNotifications && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="warning"
                      size="icon-sm"
                      aria-label={updateLabel}
                      onClick={() =>
                        navigate("/settings/general", {
                          state: { scrollTarget: "system-updates" },
                        })
                      }
                    >
                      <ArrowUpCircle className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">{updateLabel}</TooltipContent>
                </Tooltip>
              )}

              {user?.impersonation?.active && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="warning"
                      size="icon-sm"
                      onClick={() => void handleStopImpersonating()}
                      pending={stoppingImpersonation}
                      aria-label="Stop impersonating"
                    >
                      <UserRoundX className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Stop impersonating</TooltipContent>
                </Tooltip>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Account menu">
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={user?.avatarUrl ?? undefined} />
                      <AvatarFallback className="text-xs">
                        {getInitials(user?.name ?? null)}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="right" className="w-64">
                  <AccountMenuContent onLogout={handleLogout} onNavigate={onNavigate} />
                </DropdownMenuContent>
              </DropdownMenu>
            </TooltipProvider>
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex h-full w-full min-w-0 flex-col"
          >
            {!alwaysExpanded && onSidebarWidthChange && (
              <ResizeHandle
                side="left"
                onResize={onSidebarWidthChange}
                onResizeStart={onResizeStart}
                onResizeEnd={onResizeEnd}
                minWidth={200}
                maxWidth={480}
              />
            )}

            {/* Header */}
            <div
              className="flex items-center justify-between px-2"
              style={{ paddingTop: 10, paddingBottom: 10, paddingLeft: 10 }}
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground/80 whitespace-nowrap pl-1">
                <img src="/android-chrome-192x192.png" alt="Gateway" className="h-5 w-5" />
                Gateway
              </span>

              <div className="flex items-center gap-0.5">
                <AIButton />
                {alwaysExpanded ? (
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    aria-label="Close navigation"
                    onClick={onNavigate}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-lg"
                        aria-label="Close sidebar"
                        className="md:h-7 md:w-7"
                        onClick={toggleSidebar}
                      >
                        <PanelLeftClose className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Close sidebar</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>

            {/* Search */}
            <div className="relative border-y border-border">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search..."
                readOnly
                onClick={() => openPalette(true)}
                style={{ height: 44 }}
                className="pl-9 text-sm border-0 focus-visible:ring-0 focus-visible:outline-none cursor-pointer"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs tracking-widest text-muted-foreground hidden md:inline">
                ⌘K
              </span>
            </div>

            {/* Navigation */}
            <ScrollArea className="flex-1 overflow-hidden min-w-0">
              {effectiveGroups.map((group, groupIndex) => (
                <div key={group.label}>
                  {groupIndex > 0 && <Separator />}

                  {/* Pinned items — right after Dashboard */}
                  {groupIndex === 1 && <SidebarPinnedResources onNavigate={onNavigate} />}
                  <nav className="space-y-0.5 px-2 py-2">
                    {groupIndex > 0 && (
                      <p className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {group.label}
                      </p>
                    )}
                    {group.items.map((item) => {
                      const isActive = isSidebarNavigationActive(location.pathname, item.href);
                      const navigationAttention = navigationAttentionForItem(
                        dashboardBootstrap,
                        item.id
                      );
                      return (
                        <Link
                          key={item.href}
                          to={item.href}
                          onClick={onNavigate}
                          className={cn(
                            "flex items-center gap-3 px-3 py-2 text-sm whitespace-nowrap overflow-hidden",
                            SIDEBAR_ITEM_FADE,
                            isActive
                              ? cn(SIDEBAR_ITEM_FILL, "text-sidebar-accent-foreground font-medium")
                              : cn(
                                  SIDEBAR_ITEM_HOVER_FILL,
                                  "text-sidebar-foreground/70 hover:text-sidebar-accent-foreground"
                                )
                          )}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{item.name}</span>
                          {item.id === "dashboard" && dashboardAttention && (
                            <span
                              aria-label={dashboardAttentionLabel(dashboardAttention)}
                              className={cn(
                                "ml-auto h-2 w-2 shrink-0",
                                dashboardAttentionDotClass(dashboardAttention)
                              )}
                            />
                          )}
                          {navigationAttention && (
                            <span
                              aria-label={navigationAttentionLabel(item.id, navigationAttention)}
                              className={cn(
                                "ml-auto h-2 w-2 shrink-0",
                                dashboardAttentionDotClass(navigationAttention)
                              )}
                            />
                          )}
                        </Link>
                      );
                    })}
                  </nav>
                </div>
              ))}
            </ScrollArea>

            <Separator />

            {/* Relay Pool update in progress; it never blocks the app. */}
            {showRelayUpdate && (
              <>
                <div className="px-2 py-2">
                  <Button asChild variant="secondary" className="w-full justify-start px-3">
                    <Link to="/settings/relay" onClick={onNavigate}>
                      <RotateCw className={cn("h-4 w-4 shrink-0", RELAY_UPDATE_ICON_CLASS)} />
                      <span className="truncate">{relayUpdateLabel}</span>
                    </Link>
                  </Button>
                </div>
                <Separator />
              </>
            )}

            {/* Update notification */}
            {updateAvailable && hasScope("admin:update") && showUpdateNotifications && (
              <>
                <div className="px-2 py-2">
                  <Button asChild variant="warning" className="w-full justify-start px-3">
                    <Link
                      to="/settings/general"
                      state={{ scrollTarget: "system-updates" }}
                      onClick={onNavigate}
                    >
                      <ArrowUpCircle className="h-4 w-4 shrink-0" />
                      <span className="truncate">{updateLabel}</span>
                    </Link>
                  </Button>
                </div>
                <Separator />
              </>
            )}

            {user?.impersonation?.active && (
              <>
                <div className="px-2 py-2">
                  <Button
                    className="w-full justify-start px-3"
                    onClick={() => void handleStopImpersonating()}
                    pending={stoppingImpersonation}
                  >
                    <UserRoundX className="h-4 w-4 shrink-0" />
                    <span className="truncate">Stop impersonating</span>
                  </Button>
                </div>
                <Separator />
              </>
            )}

            <div className="px-2 py-2">
              <AIButton showLabel />
            </div>

            <Separator />

            {/* Account at bottom */}
            <div className="p-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="flex h-auto w-full items-center justify-start gap-2 px-1 py-1.5"
                  >
                    <Avatar className="h-7 w-7 shrink-0">
                      <AvatarImage src={user?.avatarUrl ?? undefined} />
                      <AvatarFallback className="text-xs">
                        {getInitials(user?.name ?? null)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate text-sm font-medium">{user?.name || "User"}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-64">
                  <AccountMenuContent onLogout={handleLogout} onNavigate={onNavigate} />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
