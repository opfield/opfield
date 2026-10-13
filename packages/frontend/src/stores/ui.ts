import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type AIApprovalMode, isAIApprovalMode } from "@/lib/ai-approval-mode";
import { isCompactPanelsViewport } from "@/lib/responsive-panels";
import type { PreferredInterface } from "@/services/api-auth";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

export const UI_STORAGE_KEY = "opfield-ui";

interface ModalState {
  type: string | null;
  props?: Record<string, unknown>;
}

export interface RecentPage {
  path: string;
  label: string;
  icon?: string;
  resourceKey?: string;
}

export interface CommandActionUsage {
  userId: string;
  context: string;
  actionId: string;
  count: number;
  lastUsedAt: number;
}

const MAX_COMMAND_ACTION_USAGE_ENTRIES = 200;

function commandActionUsageKey(userId: string, context: string, actionId: string): string {
  return `${userId}\u001f${context}\u001f${actionId}`;
}

function usesCompactPanelsLayout(): boolean {
  return typeof window !== "undefined" && isCompactPanelsViewport(window.innerWidth);
}

const UUID_PATH_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LEGACY_ID_DETAIL_PATHS = [
  new RegExp(`^/(?:nodes|databases|proxy-hosts)/${UUID_PATH_SEGMENT}(?:/|$)`, "i"),
  new RegExp(`^/logging/(?:environments|schemas)/${UUID_PATH_SEGMENT}(?:/|$)`, "i"),
  new RegExp(`^/docker/(?:containers|deployments|volumes)/${UUID_PATH_SEGMENT}(?:/|$)`, "i"),
];

export function filterLegacyIdRecentPages(pages: RecentPage[] | undefined): RecentPage[] {
  if (!Array.isArray(pages)) return [];
  return pages.filter(
    (page) =>
      !!page?.resourceKey ||
      !LEGACY_ID_DETAIL_PATHS.some((pattern) => pattern.test(page?.path ?? ""))
  );
}

interface UIState {
  // Theme
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  setResolvedTheme: (theme: ResolvedTheme) => void;

  // Sidebar
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  aiWorkspaceSidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  // Mobile
  isMobile: boolean;
  setIsMobile: (isMobile: boolean) => void;
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean) => void;

  // Preferences
  showUpdateNotifications: boolean;
  setShowUpdateNotifications: (show: boolean) => void;
  showSystemCertificates: boolean;
  setShowSystemCertificates: (show: boolean) => void;

  // AI Approval Mode
  aiApprovalMode: AIApprovalMode;
  aiApprovalModeLoaded: boolean;
  setAIApprovalMode: (mode: AIApprovalMode) => void;
  hydrateAIApprovalMode: (mode: AIApprovalMode) => void;
  preferredInterface: PreferredInterface | null;
  interfacePreferenceLoaded: boolean;
  beginInterfacePreferenceLoad: () => void;
  hydratePreferredInterface: (preferredInterface: PreferredInterface | null) => void;
  setPreferredInterface: (preferredInterface: PreferredInterface) => void;

  // Command palette
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  commandActionUsage: Record<string, CommandActionUsage>;
  recordCommandActionUsage: (userId: string, context: string, actionId: string) => void;

  // AI Panel
  aiPanelOpen: boolean;
  aiLiteMode: boolean;
  aiLiteModeIntroAccepted: boolean;
  pinnedAIConversationIds: string[];
  setAIPanelOpen: (open: boolean) => void;
  setAILiteMode: (enabled: boolean) => void;
  setAILiteModeIntroAccepted: (accepted: boolean) => void;
  togglePinnedAIConversation: (conversationId: string) => void;
  toggleAIPanel: () => void;
  toggleAILiteMode: () => void;

  // Recent pages
  recentPages: RecentPage[];
  addRecentPage: (path: string, label: string, icon?: string, resourceKey?: string) => void;
  removeRecentPagesByPrefix: (pathPrefix: string) => void;

  // Modal
  modal: ModalState;
  openModal: (type: string, props?: Record<string, unknown>) => void;
  closeModal: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      // Theme
      theme: "system",
      resolvedTheme: "light",
      setTheme: (theme) => set({ theme }),
      setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),

      // Sidebar
      sidebarOpen: true,
      sidebarCollapsed: false,
      aiWorkspaceSidebarCollapsed: false,
      toggleSidebar: () =>
        set((state) => {
          const sidebarOpen = !state.sidebarOpen;
          return {
            sidebarOpen,
            sidebarCollapsed: !sidebarOpen,
            ...(state.aiLiteMode ? { aiWorkspaceSidebarCollapsed: !sidebarOpen } : {}),
            ...(sidebarOpen && usesCompactPanelsLayout() ? { aiPanelOpen: false } : {}),
          };
        }),
      setSidebarCollapsed: (sidebarCollapsed) =>
        set((state) => ({
          sidebarCollapsed,
          sidebarOpen: !sidebarCollapsed,
          ...(state.aiLiteMode ? { aiWorkspaceSidebarCollapsed: sidebarCollapsed } : {}),
          ...(!sidebarCollapsed && usesCompactPanelsLayout() ? { aiPanelOpen: false } : {}),
        })),

      // Mobile
      isMobile: false,
      setIsMobile: (isMobile) => set({ isMobile }),
      mobileMenuOpen: false,
      setMobileMenuOpen: (mobileMenuOpen) =>
        set({
          mobileMenuOpen,
          ...(mobileMenuOpen && usesCompactPanelsLayout() ? { aiPanelOpen: false } : {}),
        }),

      // Preferences
      showUpdateNotifications: true,
      setShowUpdateNotifications: (showUpdateNotifications) => set({ showUpdateNotifications }),
      showSystemCertificates: false,
      setShowSystemCertificates: (showSystemCertificates) => set({ showSystemCertificates }),

      // AI Approval Mode
      aiApprovalMode: "normal",
      aiApprovalModeLoaded: false,
      hydrateAIApprovalMode: (aiApprovalMode) =>
        set({ aiApprovalMode, aiApprovalModeLoaded: true }),
      setAIApprovalMode: (aiApprovalMode) => set({ aiApprovalMode, aiApprovalModeLoaded: true }),
      preferredInterface: null,
      interfacePreferenceLoaded: false,
      beginInterfacePreferenceLoad: () =>
        set({
          preferredInterface: null,
          interfacePreferenceLoaded: false,
          aiApprovalModeLoaded: false,
          aiLiteMode: false,
        }),
      hydratePreferredInterface: (preferredInterface) =>
        set((state) => ({
          preferredInterface,
          interfacePreferenceLoaded: true,
          aiLiteMode: preferredInterface === "ai_workspace",
          ...(preferredInterface === "ai_workspace"
            ? {
                sidebarOpen: !state.aiWorkspaceSidebarCollapsed,
                sidebarCollapsed: state.aiWorkspaceSidebarCollapsed,
              }
            : {}),
        })),
      setPreferredInterface: (preferredInterface) =>
        set((state) => ({
          preferredInterface,
          interfacePreferenceLoaded: true,
          aiLiteMode: preferredInterface === "ai_workspace",
          ...(preferredInterface === "ai_workspace"
            ? {
                sidebarOpen: !state.aiWorkspaceSidebarCollapsed,
                sidebarCollapsed: state.aiWorkspaceSidebarCollapsed,
              }
            : {}),
        })),

      // Command palette
      commandPaletteOpen: false,
      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      commandActionUsage: {},
      recordCommandActionUsage: (userId, context, actionId) =>
        set((state) => {
          const key = commandActionUsageKey(userId, context, actionId);
          const previous = state.commandActionUsage[key];
          const next = {
            ...state.commandActionUsage,
            [key]: {
              userId,
              context,
              actionId,
              count: (previous?.count ?? 0) + 1,
              lastUsedAt: Date.now(),
            },
          };
          const entries = Object.entries(next);
          if (entries.length <= MAX_COMMAND_ACTION_USAGE_ENTRIES) {
            return { commandActionUsage: next };
          }
          entries.sort(([, left], [, right]) => right.lastUsedAt - left.lastUsedAt);
          return {
            commandActionUsage: Object.fromEntries(
              entries.slice(0, MAX_COMMAND_ACTION_USAGE_ENTRIES)
            ),
          };
        }),

      // AI Panel
      aiPanelOpen: false,
      aiLiteMode: false,
      aiLiteModeIntroAccepted: false,
      pinnedAIConversationIds: [],
      setAIPanelOpen: (aiPanelOpen) =>
        set({
          aiPanelOpen,
          ...(aiPanelOpen && usesCompactPanelsLayout()
            ? { sidebarOpen: false, sidebarCollapsed: true, mobileMenuOpen: false }
            : {}),
        }),
      setAILiteMode: (aiLiteMode) =>
        set((state) => ({
          aiLiteMode,
          ...(aiLiteMode
            ? {
                sidebarOpen: !state.aiWorkspaceSidebarCollapsed,
                sidebarCollapsed: state.aiWorkspaceSidebarCollapsed,
              }
            : {}),
        })),
      setAILiteModeIntroAccepted: (aiLiteModeIntroAccepted) => set({ aiLiteModeIntroAccepted }),
      togglePinnedAIConversation: (conversationId) =>
        set((state) => ({
          pinnedAIConversationIds: state.pinnedAIConversationIds.includes(conversationId)
            ? state.pinnedAIConversationIds.filter((id) => id !== conversationId)
            : [conversationId, ...state.pinnedAIConversationIds],
        })),
      toggleAIPanel: () =>
        set((state) => {
          const aiPanelOpen = !state.aiPanelOpen;
          return {
            aiPanelOpen,
            ...(aiPanelOpen && usesCompactPanelsLayout()
              ? { sidebarOpen: false, sidebarCollapsed: true, mobileMenuOpen: false }
              : {}),
          };
        }),
      toggleAILiteMode: () =>
        set((state) => {
          const aiLiteMode = !state.aiLiteMode;
          return {
            aiLiteMode,
            ...(aiLiteMode
              ? {
                  sidebarOpen: !state.aiWorkspaceSidebarCollapsed,
                  sidebarCollapsed: state.aiWorkspaceSidebarCollapsed,
                }
              : {}),
          };
        }),

      // Recent pages
      recentPages: [],
      addRecentPage: (path, label, icon, resourceKey) =>
        set((s) => {
          const filtered = s.recentPages.filter(
            (p) => p.path !== path && (!resourceKey || p.resourceKey !== resourceKey)
          );
          return { recentPages: [{ path, label, icon, resourceKey }, ...filtered].slice(0, 8) };
        }),
      removeRecentPagesByPrefix: (pathPrefix) =>
        set((s) => ({
          recentPages: s.recentPages.filter(
            (page) => page.path !== pathPrefix && !page.path.startsWith(`${pathPrefix}/`)
          ),
        })),

      // Modal
      modal: { type: null },
      openModal: (type, props) => set({ modal: { type, props } }),
      closeModal: () => set({ modal: { type: null } }),
    }),
    {
      name: UI_STORAGE_KEY,
      version: 1,
      partialize: (state) => ({
        theme: state.theme,
        sidebarOpen: state.sidebarOpen,
        sidebarCollapsed: state.sidebarCollapsed,
        aiWorkspaceSidebarCollapsed: state.aiWorkspaceSidebarCollapsed,
        showUpdateNotifications: state.showUpdateNotifications,
        showSystemCertificates: state.showSystemCertificates,
        aiPanelOpen: state.aiPanelOpen,
        aiLiteMode: state.aiLiteMode,
        aiLiteModeIntroAccepted: state.aiLiteModeIntroAccepted,
        pinnedAIConversationIds: state.pinnedAIConversationIds,
        aiApprovalMode: state.aiApprovalMode,
        recentPages: state.recentPages,
        commandActionUsage: state.commandActionUsage,
      }),
      migrate: (persisted, persistedVersion) => {
        const state = persisted as (Partial<UIState> & Record<string, unknown>) | undefined;
        if (!state) return persisted;
        return {
          theme: state.theme,
          sidebarOpen: state.sidebarOpen,
          sidebarCollapsed: state.sidebarCollapsed,
          aiWorkspaceSidebarCollapsed: state.aiWorkspaceSidebarCollapsed ?? false,
          showUpdateNotifications: state.showUpdateNotifications,
          showSystemCertificates: state.showSystemCertificates,
          aiPanelOpen: state.aiPanelOpen,
          aiLiteMode: state.aiLiteMode,
          aiLiteModeIntroAccepted: state.aiLiteModeIntroAccepted,
          pinnedAIConversationIds: state.pinnedAIConversationIds,
          aiApprovalMode: isAIApprovalMode(state.aiApprovalMode) ? state.aiApprovalMode : "normal",
          recentPages:
            persistedVersion < 1 ? filterLegacyIdRecentPages(state.recentPages) : state.recentPages,
          commandActionUsage: state.commandActionUsage ?? {},
        };
      },
    }
  )
);

export function syncAILiteModeFromStorageValue(value: string | null): void {
  if (value == null) return;

  try {
    const parsed = JSON.parse(value) as { state?: { aiLiteMode?: unknown } };
    const aiLiteMode = parsed.state?.aiLiteMode;
    if (typeof aiLiteMode !== "boolean") return;

    const current = useUIStore.getState();
    if (current.aiLiteMode === aiLiteMode && (!aiLiteMode || !current.aiPanelOpen)) return;

    useUIStore.setState({
      aiLiteMode,
      ...(aiLiteMode ? { aiPanelOpen: false } : {}),
    });
  } catch {
    // Ignore malformed persisted UI state from another tab.
  }
}
