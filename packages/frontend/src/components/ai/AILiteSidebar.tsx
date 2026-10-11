import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronRight,
  Compass,
  Folder,
  LayoutDashboard,
  MessageSquare,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Search,
  UserRoundX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AccountMenuContent } from "@/components/layout/AccountMenuContent";
import {
  dashboardAttentionDotClass,
  dashboardAttentionLabel,
} from "@/components/layout/dashboard-attention";
import {
  navigationAttentionForItem,
  navigationAttentionLabel,
} from "@/components/layout/navigation-attention";
import { SidebarPinnedResources } from "@/components/layout/SidebarPinnedResources";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { aiConversationRoute } from "@/lib/ai-conversation-route";
import { visibleNavigationGroups } from "@/lib/app-navigation";
import { hasLowInferenceUsage } from "@/lib/inference-self-usage";
import { isSidebarNavigationActive } from "@/lib/sidebar-navigation";
import { cn, getInitials } from "@/lib/utils";
import type { AIConversationSummary } from "@/services/ai-conversations";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { useDockerStore } from "@/stores/docker";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { AIConversationStatusIndicator } from "./AIConversationStatusIndicator";
import {
  ConversationDragOverlayItem,
  ConversationFolderDialog,
  ConversationMenuItem,
  DraggableConversationMenuItem,
  type FolderDialogState,
  FolderMenuItem,
  RootConversationDropZone,
  type SidebarPointerPosition,
} from "./AILiteSidebar.parts";
import { AIProgressRing } from "./AIProgressRing";

const EXPANDED_PROJECT_IDS_STORAGE_KEY = "gateway-ai-lite-expanded-project-ids";

function readExpandedProjectIds(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_PROJECT_IDS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function writeExpandedProjectIds(ids: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_PROJECT_IDS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore unavailable storage; project expansion still works for the current session.
  }
}

interface AILiteSidebarProps {
  alwaysExpanded?: boolean;
  mobileMenu?: boolean;
  onClose?: () => void;
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  isResizing?: boolean;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

export function AILiteSidebar({
  alwaysExpanded = false,
  mobileMenu = false,
  onClose,
  sidebarWidth = 260,
  onSidebarWidthChange,
  isResizing = false,
  onResizeStart,
  onResizeEnd,
}: AILiteSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, hasAnyScope, hasScopedAccess, logout } = useAuthStore();
  const {
    sidebarOpen,
    toggleSidebar,
    pinnedAIConversationIds,
    togglePinnedAIConversation,
    setCommandPaletteOpen: openPalette,
  } = useUIStore();
  const dashboardBootstrap = useDashboardBootstrapStore((s) => s.snapshot);
  const dashboardAttention = dashboardBootstrap?.attention.severity ?? null;
  const sectionAttention = Object.values(dashboardBootstrap?.navigationAttention ?? {}).includes(
    "critical"
  )
    ? "critical"
    : Object.values(dashboardBootstrap?.navigationAttention ?? {}).includes("warning")
      ? "warning"
      : null;
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const siemEnabled = useSystemConfigStore((s) => s.config.features.siemEnabled);
  const loggingEnabled = useSystemConfigStore((s) => s.config.features.loggingEnabled);
  const inferenceEnabled = useSystemConfigStore((s) => s.config.features.inferenceEnabled);
  const navigationBootstrap = useUIBootstrapStore((s) => s.snapshot?.navigation);
  const dockerNodes = useDockerStore((s) => s.dockerNodes);
  const {
    messages,
    sidebarActiveConversationId,
    recentConversations,
    conversationFolders,
    isStartingConversation,
    clearMessages,
    createConversationFolder,
    deleteConversation,
    deleteConversationFolder,
    fetchConversationFolders,
    fetchRecentConversations,
    loadConversation,
    moveConversationsToFolder,
    reorderConversationFolders,
    updateConversationFolder,
  } = useAIStore();
  // Pinned chats and projects render above the chat list, so a list arriving
  // late would push it down. Without a cached list the conversation sections
  // wait for the first fetch, then fade in together.
  const [conversationListCached] = useState(
    () => useAIStore.getState().recentConversations.length > 0
  );
  const [conversationListSettled, setConversationListSettled] = useState(conversationListCached);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const pointerPositionRef = useRef<SidebarPointerPosition | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(readExpandedProjectIds);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const {
    open: folderDialogOpen,
    value: folderDialog,
    setValue: setFolderDialog,
    onOpenChange: onFolderDialogOpenChange,
  } = useDeferredDialogState<FolderDialogState>();
  const [dragOverlayConversationId, setDragOverlayConversationId] = useState<string | null>(null);
  const [stoppingImpersonation, setStoppingImpersonation] = useState(false);
  const canAccessAdministration = hasAnyScope("admin:audit", "admin:users", "admin:groups");
  const visibleGroups = visibleNavigationGroups({
    scopes: user?.scopes ?? [],
    pkiEnabled,
    siemEnabled,
    loggingEnabled,
    inferenceEnabled,
    hasLowInferenceUsage: hasLowInferenceUsage(dashboardBootstrap?.inferenceUsage ?? null),
    statusPageEnabled: navigationBootstrap?.statusPageEnabled ?? false,
    pagesEnabled: navigationBootstrap?.pagesEnabled ?? false,
    hasNginxNodes: navigationBootstrap?.hasNginxNodes ?? true,
    hasCloudflareIntegration: navigationBootstrap?.hasCloudflareIntegration ?? false,
    hasDockerNodes:
      dockerNodes.length > 0 ||
      [
        "docker:containers:view",
        "docker:images:view",
        "docker:volumes:view",
        "docker:networks:view",
      ].some(hasScopedAccess),
  });
  const profileNavigationItem = visibleGroups
    .flatMap((group) => group.items)
    .find((item) => item.id === "profile");
  const navigateToGroups = visibleGroups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          item.id !== "dashboard" &&
          item.id !== "profile" &&
          item.id !== "settings" &&
          item.id !== "administration"
      ),
    }))
    .filter((group) => group.items.length > 0);
  const isExpanded = alwaysExpanded || sidebarOpen;
  const pinnedConversationSet = new Set(pinnedAIConversationIds);
  const pinnedConversations = pinnedAIConversationIds
    .map((id) => recentConversations.find((conversation) => conversation.id === id))
    .filter((conversation): conversation is AIConversationSummary => Boolean(conversation));
  const chatConversations = recentConversations.filter(
    (conversation) => !pinnedConversationSet.has(conversation.id)
  );
  const sortedFolders = [...conversationFolders].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
  const conversationsByFolder = new Map<string | null, AIConversationSummary[]>();
  conversationsByFolder.set(null, []);
  for (const folder of sortedFolders) conversationsByFolder.set(folder.id, []);
  for (const conversation of chatConversations) {
    const folderId =
      conversation.folderId && conversationsByFolder.has(conversation.folderId)
        ? conversation.folderId
        : null;
    conversationsByFolder.get(folderId)?.push(conversation);
  }
  const rootConversations = conversationsByFolder.get(null) ?? [];
  const dragOverlayConversation = dragOverlayConversationId
    ? recentConversations.find((conversation) => conversation.id === dragOverlayConversationId)
    : null;
  const visibleActiveConversationId = messages.length > 0 ? sidebarActiveConversationId : null;

  useEffect(() => {
    void Promise.allSettled([
      Promise.resolve(fetchRecentConversations()),
      Promise.resolve(fetchConversationFolders()),
    ]).then(() => setConversationListSettled(true));
  }, [fetchConversationFolders, fetchRecentConversations]);

  useEffect(() => {
    writeExpandedProjectIds(expandedFolderIds);
  }, [expandedFolderIds]);

  const handleNewChat = () => {
    useAIStore.setState({ sidebarActiveConversationId: null });
    navigate("/", { flushSync: true });
    clearMessages();
  };

  const handleLoadConversation = async (conversationId: string) => {
    if (conversationId === sidebarActiveConversationId) {
      navigate(aiConversationRoute(conversationId));
      return;
    }
    await loadConversation(conversationId);
    navigate(aiConversationRoute(conversationId));
  };

  const handleDeleteConversation = async (conversationId: string) => {
    const deletingActiveConversation = conversationId === visibleActiveConversationId;
    await deleteConversation(conversationId);
    if (deletingActiveConversation) navigate("/");
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // Local auth state still needs to clear if the server session is already gone.
    } finally {
      logout();
      navigate("/login");
    }
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

  const handleOpenOperationsConsole = () => {
    window.dispatchEvent(new CustomEvent("gateway:open-operations-console"));
  };

  const handleToggleFolder = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const handleCreateFolder = async (name: string, description: string) => {
    const folder = await createConversationFolder({ name, description });
    if (folder) {
      setExpandedFolderIds((current) => new Set([...current, folder.id]));
      setFolderDialog(null);
    }
  };

  const handleUpdateFolder = async (folderId: string, name: string, description: string) => {
    await updateConversationFolder(folderId, { name, description });
    setFolderDialog(null);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const activeData = event.active.data.current;
    setDragOverlayConversationId(
      activeData?.type === "conversation" && typeof activeData.conversationId === "string"
        ? activeData.conversationId
        : null
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragOverlayConversationId(null);
    const activeData = event.active.data.current;
    const overData = event.over?.data.current;
    if (!activeData || !overData) return;

    if (activeData.type === "folder" && overData.type === "folder") {
      const oldIndex = sortedFolders.findIndex((folder) => folder.id === activeData.folderId);
      const newIndex = sortedFolders.findIndex((folder) => folder.id === overData.folderId);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      void reorderConversationFolders(
        arrayMove(sortedFolders, oldIndex, newIndex).map((folder) => folder.id)
      );
      return;
    }

    if (activeData.type === "conversation") {
      const targetFolderId =
        overData.type === "root"
          ? null
          : typeof overData.folderId === "string"
            ? overData.folderId
            : null;
      if (activeData.folderId === targetFolderId) return;
      void moveConversationsToFolder([activeData.conversationId], targetFolderId);
    }
  };

  return (
    <aside
      style={{ width: alwaysExpanded ? "100%" : isExpanded ? sidebarWidth : 48 }}
      onPointerEnter={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerDownCapture={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerLeave={() => {
        pointerPositionRef.current = null;
      }}
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-visible border-r border-sidebar-border bg-sidebar-background",
        !isResizing && "transition-[width] duration-200 ease-out"
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
                    onClick={toggleSidebar}
                    aria-label="Open sidebar"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Open sidebar</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => openPalette(true)}
                    aria-label="Search"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Search</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleNewChat}
                    aria-label="New Work Session"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">New Work Session</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon-sm"
                    className={cn(
                      isSidebarNavigationActive(location.pathname, "/dashboard") &&
                        "bg-sidebar-accent"
                    )}
                    aria-label="Dashboard"
                  >
                    <Link to="/dashboard">
                      <span className="relative flex">
                        <LayoutDashboard className="h-4 w-4" />
                        {dashboardAttention && (
                          <span
                            aria-label={dashboardAttentionLabel(dashboardAttention)}
                            className={cn(
                              "absolute -right-2 -top-2 h-2 w-2",
                              dashboardAttentionDotClass(dashboardAttention)
                            )}
                          />
                        )}
                      </span>
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Dashboard</TooltipContent>
              </Tooltip>

              {profileNavigationItem && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      asChild
                      variant="ghost"
                      size="icon-sm"
                      className={cn(
                        isSidebarNavigationActive(location.pathname, profileNavigationItem.href) &&
                          "bg-sidebar-accent"
                      )}
                      aria-label={profileNavigationItem.name}
                    >
                      <Link to={profileNavigationItem.href}>
                        <profileNavigationItem.icon className="h-4 w-4" />
                      </Link>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">{profileNavigationItem.name}</TooltipContent>
                </Tooltip>
              )}
              <Separator className="my-1 w-6" />

              <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden dashboard-scrollbar">
                {isStartingConversation && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="bg-sidebar-accent"
                        aria-label="Starting Work Session..."
                      >
                        <AIProgressRing ariaLabel="Starting Work Session" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Starting Work Session...</TooltipContent>
                  </Tooltip>
                )}
                {conversationListSettled &&
                  recentConversations.length === 0 &&
                  !isStartingConversation && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="bg-sidebar-accent"
                          aria-label="New Work Session"
                          onClick={handleNewChat}
                        >
                          <MessageSquare className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">New Work Session</TooltipContent>
                    </Tooltip>
                  )}
                {recentConversations.map((conversation) => {
                  return (
                    <Tooltip key={conversation.id}>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className={cn(
                            visibleActiveConversationId === conversation.id && "bg-sidebar-accent"
                          )}
                          aria-label={conversation.title}
                          onClick={() => void handleLoadConversation(conversation.id)}
                        >
                          <AIConversationStatusIndicator conversation={conversation} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">{conversation.title}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </nav>

              {navigateToGroups.length > 0 && (
                <Tooltip>
                  <DropdownMenu>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="All sections">
                          <span className="relative flex">
                            <Compass className="h-4 w-4" />
                            {sectionAttention && (
                              <span
                                aria-label={
                                  sectionAttention === "critical"
                                    ? "Some sections have critical issues"
                                    : "Some sections require attention"
                                }
                                className={cn(
                                  "absolute -right-2 -top-2 h-2 w-2",
                                  dashboardAttentionDotClass(sectionAttention)
                                )}
                              />
                            )}
                          </span>
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="right">All sections</TooltipContent>
                    <DropdownMenuContent
                      side="right"
                      align="end"
                      className="max-h-[min(70vh,34rem)] w-60 overflow-y-auto"
                    >
                      {navigateToGroups.map((group, groupIndex) => (
                        <div key={group.id}>
                          {groupIndex > 0 && <DropdownMenuSeparator />}
                          <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                            {group.label}
                          </DropdownMenuLabel>
                          {group.items.map((item) => {
                            const attention = navigationAttentionForItem(
                              dashboardBootstrap,
                              item.id
                            );
                            return (
                              <DropdownMenuItem key={item.id} onSelect={() => navigate(item.href)}>
                                <item.icon className="h-4 w-4" />
                                <span>{item.name}</span>
                                {attention && (
                                  <span
                                    aria-label={navigationAttentionLabel(item.id, attention)}
                                    className={cn(
                                      "ml-auto h-2 w-2 shrink-0",
                                      dashboardAttentionDotClass(attention)
                                    )}
                                  />
                                )}
                              </DropdownMenuItem>
                            );
                          })}
                        </div>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </Tooltip>
              )}

              {
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="bg-sidebar-accent text-sidebar-accent-foreground/80 hover:bg-muted hover:text-sidebar-accent-foreground"
                      onClick={handleOpenOperationsConsole}
                      aria-label="Open Operations Console"
                    >
                      <PanelLeft className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Open Operations Console</TooltipContent>
                </Tooltip>
              }

              {user?.impersonation?.active && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      onClick={() => void handleStopImpersonating()}
                      disabled={stoppingImpersonation}
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
                        {getInitials(user?.name || user?.email || "?")}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="right" className="w-64">
                  <AccountMenuContent
                    showAdministration={canAccessAdministration}
                    onLogout={handleLogout}
                  />
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
            {onSidebarWidthChange && (
              <ResizeHandle
                side="left"
                onResize={onSidebarWidthChange}
                onResizeStart={onResizeStart}
                onResizeEnd={onResizeEnd}
                minWidth={200}
                maxWidth={480}
              />
            )}

            <div
              className={cn("flex items-center justify-between px-2", mobileMenu && "h-12")}
              style={
                mobileMenu ? undefined : { paddingTop: 10, paddingBottom: 10, paddingLeft: 10 }
              }
            >
              <span className="flex items-center gap-1.5 whitespace-nowrap pl-1 text-sm font-semibold text-foreground/80">
                <img src="/android-chrome-192x192.png" alt="Gateway" className="h-5 w-5" />
                Gateway AI
              </span>
              <div className="flex items-center gap-0.5">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size={mobileMenu ? "icon-sm" : "icon-lg"}
                      className="md:h-7 md:w-7"
                      aria-label="Create"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={handleNewChat}>
                      <MessageSquare className="mr-2 h-4 w-4" />
                      New Work Session
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setFolderDialog({ mode: "create", name: "", description: "" })}
                    >
                      <Folder className="mr-2 h-4 w-4" />
                      New project
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size={mobileMenu ? "icon-sm" : "icon-lg"}
                      className="md:h-7 md:w-7"
                      onClick={onClose ?? toggleSidebar}
                      aria-label={onClose ? "Close menu" : "Close sidebar"}
                    >
                      {onClose ? <X className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{onClose ? "Close menu" : "Close sidebar"}</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="relative border-y border-border">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search..."
                readOnly
                onClick={() => openPalette(true)}
                style={{ height: 44 }}
                className="cursor-pointer border-0 pl-9 text-sm focus-visible:outline-none focus-visible:ring-0"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 text-xs tracking-widest text-muted-foreground md:inline">
                ⌘K
              </span>
            </div>

            <div className="border-b border-border px-2 py-2">
              <Link
                to="/dashboard"
                className={cn(
                  "flex items-center gap-3 px-3 py-2 text-sm transition-colors",
                  isSidebarNavigationActive(location.pathname, "/dashboard")
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <LayoutDashboard className="h-4 w-4 shrink-0" />
                <span>Dashboard</span>
                {dashboardAttention && (
                  <span
                    aria-label={dashboardAttentionLabel(dashboardAttention)}
                    className={cn(
                      "ml-auto h-2 w-2 shrink-0",
                      dashboardAttentionDotClass(dashboardAttention)
                    )}
                  />
                )}
              </Link>
              {profileNavigationItem && (
                <Link
                  to={profileNavigationItem.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 text-sm transition-colors",
                    isSidebarNavigationActive(location.pathname, profileNavigationItem.href)
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                >
                  <profileNavigationItem.icon className="h-4 w-4 shrink-0" />
                  <span>{profileNavigationItem.name}</span>
                </Link>
              )}
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto dashboard-scrollbar">
                <SidebarPinnedResources loadBootstrap />
                <div
                  className={cn(
                    !conversationListSettled && "invisible",
                    conversationListSettled && !conversationListCached && "ai-chat-content-fade-in"
                  )}
                  aria-busy={conversationListSettled ? undefined : true}
                >
                  {pinnedConversations.length > 0 && (
                    <nav className="space-y-0.5 px-2 py-2">
                      <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Pinned
                      </p>
                      {pinnedConversations.map((conversation) => (
                        <ConversationMenuItem
                          key={conversation.id}
                          conversation={conversation}
                          active={visibleActiveConversationId === conversation.id}
                          pinned
                          disableLayoutAnimation={isResizing}
                          hoverSyncRevision={recentConversations.length}
                          pointerPositionRef={pointerPositionRef}
                          onLoad={() => void handleLoadConversation(conversation.id)}
                          onTogglePin={() => togglePinnedAIConversation(conversation.id)}
                          onDelete={() => void handleDeleteConversation(conversation.id)}
                        />
                      ))}
                    </nav>
                  )}

                  <DndContext
                    sensors={sensors}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragCancel={() => setDragOverlayConversationId(null)}
                  >
                    {sortedFolders.length > 0 && (
                      <nav className="space-y-0.5 px-2 py-2">
                        <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Projects
                        </p>
                        <SortableContext
                          items={sortedFolders.map((folder) => folder.id)}
                          strategy={verticalListSortingStrategy}
                        >
                          {sortedFolders.map((folder) => {
                            const folderConversations = conversationsByFolder.get(folder.id) ?? [];
                            const isFolderExpanded = expandedFolderIds.has(folder.id);
                            return (
                              <div key={folder.id} className="space-y-0.5">
                                <FolderMenuItem
                                  folder={folder}
                                  conversations={folderConversations}
                                  expanded={isFolderExpanded}
                                  onToggle={() => handleToggleFolder(folder.id)}
                                  onEdit={() =>
                                    setFolderDialog({
                                      mode: "edit",
                                      folderId: folder.id,
                                      name: folder.name,
                                      description: folder.description,
                                    })
                                  }
                                  onDelete={() => void deleteConversationFolder(folder.id)}
                                />
                                {folderConversations.length > 0 && (
                                  <AnimatePresence initial={false}>
                                    {isFolderExpanded && (
                                      <motion.div
                                        key={`${folder.id}-conversations`}
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: "auto", opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.16, ease: "easeOut" }}
                                        className="overflow-hidden"
                                      >
                                        <div className="space-y-0.5 pl-4">
                                          {folderConversations.map((conversation) => (
                                            <DraggableConversationMenuItem
                                              key={conversation.id}
                                              conversation={conversation}
                                              folderId={folder.id}
                                              active={
                                                visibleActiveConversationId === conversation.id
                                              }
                                              pinned={false}
                                              disableLayoutAnimation={isResizing}
                                              hoverSyncRevision={recentConversations.length}
                                              pointerPositionRef={pointerPositionRef}
                                              onLoad={() =>
                                                void handleLoadConversation(conversation.id)
                                              }
                                              onTogglePin={() =>
                                                togglePinnedAIConversation(conversation.id)
                                              }
                                              onDelete={() =>
                                                void handleDeleteConversation(conversation.id)
                                              }
                                            />
                                          ))}
                                        </div>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                )}
                              </div>
                            );
                          })}
                        </SortableContext>
                      </nav>
                    )}

                    <nav className="space-y-0.5 px-2 py-2">
                      <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Chats
                      </p>
                      {isStartingConversation && (
                        <div
                          aria-current="page"
                          className="flex w-full items-center gap-3 overflow-hidden whitespace-nowrap bg-sidebar-accent px-3 py-2 text-left text-sm font-medium text-sidebar-accent-foreground"
                        >
                          <MessageSquare className="h-4 w-4 shrink-0" />
                          <span className="thinking-shimmer truncate text-muted-foreground">
                            Starting Work Session...
                          </span>
                        </div>
                      )}
                      {recentConversations.length === 0 &&
                      sortedFolders.length === 0 &&
                      !isStartingConversation ? (
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 overflow-hidden whitespace-nowrap bg-sidebar-accent px-3 py-2 text-left text-sm font-medium text-sidebar-accent-foreground"
                          onClick={handleNewChat}
                        >
                          <MessageSquare className="h-4 w-4 shrink-0" />
                          <span className="truncate">New Work Session</span>
                        </button>
                      ) : (
                        <RootConversationDropZone>
                          {rootConversations.map((conversation) => (
                            <DraggableConversationMenuItem
                              key={conversation.id}
                              conversation={conversation}
                              folderId={null}
                              active={visibleActiveConversationId === conversation.id}
                              pinned={false}
                              disableLayoutAnimation={isResizing}
                              hoverSyncRevision={recentConversations.length}
                              pointerPositionRef={pointerPositionRef}
                              onLoad={() => void handleLoadConversation(conversation.id)}
                              onTogglePin={() => togglePinnedAIConversation(conversation.id)}
                              onDelete={() => void handleDeleteConversation(conversation.id)}
                            />
                          ))}
                        </RootConversationDropZone>
                      )}
                    </nav>
                    <DragOverlay dropAnimation={null}>
                      {dragOverlayConversation ? (
                        <ConversationDragOverlayItem
                          conversation={dragOverlayConversation}
                          width={Math.max(160, Math.min(sidebarWidth - 32, 360))}
                        />
                      ) : null}
                    </DragOverlay>
                  </DndContext>
                </div>
              </div>
            </div>

            <div className="border-t border-border">
              {navigateToGroups.length > 0 && (
                <>
                  <div className="px-2 py-2">
                    {mobileMenu ? (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={() => setSectionsOpen(true)}
                      >
                        <span className="relative flex shrink-0">
                          <Compass className="h-4 w-4" />
                          {sectionAttention && (
                            <span
                              aria-label={
                                sectionAttention === "critical"
                                  ? "Some sections have critical issues"
                                  : "Some sections require attention"
                              }
                              className={cn(
                                "absolute -right-2 -top-2 h-2 w-2",
                                dashboardAttentionDotClass(sectionAttention)
                              )}
                            />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate">All sections</span>
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      </button>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <span className="relative flex shrink-0">
                              <Compass className="h-4 w-4" />
                              {sectionAttention && (
                                <span
                                  aria-label={
                                    sectionAttention === "critical"
                                      ? "Some sections have critical issues"
                                      : "Some sections require attention"
                                  }
                                  className={cn(
                                    "absolute -right-2 -top-2 h-2 w-2",
                                    dashboardAttentionDotClass(sectionAttention)
                                  )}
                                />
                              )}
                            </span>
                            <span className="min-w-0 flex-1 truncate">All sections</span>
                            <ChevronRight className="h-4 w-4 shrink-0" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          side="right"
                          align="end"
                          className="max-h-[min(70vh,34rem)] w-60 overflow-y-auto"
                        >
                          {navigateToGroups.map((group, groupIndex) => (
                            <div key={group.id}>
                              {groupIndex > 0 && <DropdownMenuSeparator />}
                              <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                {group.label}
                              </DropdownMenuLabel>
                              {group.items.map((item) => {
                                const attention = navigationAttentionForItem(
                                  dashboardBootstrap,
                                  item.id
                                );
                                return (
                                  <DropdownMenuItem
                                    key={item.id}
                                    onSelect={() => navigate(item.href)}
                                  >
                                    <item.icon className="h-4 w-4" />
                                    <span>{item.name}</span>
                                    {attention && (
                                      <span
                                        aria-label={navigationAttentionLabel(item.id, attention)}
                                        className={cn(
                                          "ml-auto h-2 w-2 shrink-0",
                                          dashboardAttentionDotClass(attention)
                                        )}
                                      />
                                    )}
                                  </DropdownMenuItem>
                                );
                              })}
                            </div>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  <Separator />
                </>
              )}
              {
                <>
                  <div className="px-2 py-2">
                    <button
                      type="button"
                      onClick={handleOpenOperationsConsole}
                      className="flex w-full items-center gap-2 bg-sidebar-accent px-3 py-2 text-left text-sm font-medium text-sidebar-accent-foreground/80 transition-colors hover:bg-muted hover:text-sidebar-accent-foreground"
                    >
                      <PanelLeft className="h-4 w-4 shrink-0" />
                      <span className="truncate">Open Operations Console</span>
                    </button>
                  </div>
                  <Separator />
                </>
              }
              {user?.impersonation?.active && (
                <>
                  <div className="px-2 py-2">
                    <Button
                      className="w-full justify-start px-3"
                      onClick={() => void handleStopImpersonating()}
                      disabled={stoppingImpersonation}
                    >
                      <UserRoundX className="h-4 w-4 shrink-0" />
                      <span className="truncate">Stop impersonating</span>
                    </Button>
                  </div>
                  <Separator />
                </>
              )}
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
                          {getInitials(user?.name || user?.email || "?")}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate text-sm font-medium">{user?.name || "User"}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-64">
                    <AccountMenuContent
                      showAdministration={canAccessAdministration}
                      onLogout={handleLogout}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {mobileMenu && (
        <Sheet open={sectionsOpen} onOpenChange={setSectionsOpen}>
          <SheetContent
            side="bottom"
            className="flex max-h-[80dvh] w-full flex-col gap-0 rounded-t-xl p-0"
          >
            <SheetHeader className="border-b border-border px-4 py-3 text-left">
              <SheetTitle>All Sections</SheetTitle>
            </SheetHeader>
            <nav className="min-h-0 flex-1 overflow-y-auto dashboard-scrollbar">
              {navigateToGroups.map((group, groupIndex) => (
                <div key={group.id}>
                  {groupIndex > 0 && <Separator />}
                  <div className="space-y-0.5 px-2 py-2">
                    <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </p>
                    {group.items.map((item) => {
                      const isActive = isSidebarNavigationActive(location.pathname, item.href);
                      const attention = navigationAttentionForItem(dashboardBootstrap, item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={cn(
                            "flex w-full items-center gap-3 overflow-hidden whitespace-nowrap px-3 py-2 text-left text-sm transition-colors",
                            isActive
                              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                              : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                          )}
                          onClick={() => {
                            setSectionsOpen(false);
                            navigate(item.href);
                            onClose?.();
                          }}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{item.name}</span>
                          {attention && (
                            <span
                              aria-label={navigationAttentionLabel(item.id, attention)}
                              className={cn(
                                "ml-auto h-2 w-2 shrink-0",
                                dashboardAttentionDotClass(attention)
                              )}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </SheetContent>
        </Sheet>
      )}
      {folderDialog && (
        <ConversationFolderDialog
          open={folderDialogOpen}
          state={folderDialog}
          onOpenChange={onFolderDialogOpenChange}
          onCreate={(name, description) => handleCreateFolder(name, description)}
          onUpdate={(folderId, name, description) =>
            handleUpdateFolder(folderId, name, description)
          }
        />
      )}
    </aside>
  );
}
