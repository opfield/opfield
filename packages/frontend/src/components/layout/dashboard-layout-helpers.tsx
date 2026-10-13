import type { AIWorkspaceAvailability } from "@/components/ai/AIWorkspaceAvailabilityDialog";

const SIDEBAR_WIDTH_KEY = "opfield-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 260;
const COMMAND_PALETTE_SHIFT_GAP_MS = 400;

export interface CommandPaletteShiftState {
  count: number;
  lastPressAt: number;
}

export function registerCommandPaletteShiftPress(
  state: CommandPaletteShiftState,
  now: number
): { state: CommandPaletteShiftState; open: boolean } {
  const count =
    state.count > 0 && now - state.lastPressAt <= COMMAND_PALETTE_SHIFT_GAP_MS
      ? state.count + 1
      : 1;
  if (count >= 3) return { state: { count: 0, lastPressAt: 0 }, open: true };
  return { state: { count, lastPressAt: now }, open: false };
}

export function resolveInterfaceTransition(
  nextInterface: "ai_workspace" | "operations_console",
  preserveConversationInConsole = false
): { path: "/" | null; aiPanelOpen: boolean | null } {
  if (nextInterface === "ai_workspace") return { path: "/", aiPanelOpen: false };
  if (preserveConversationInConsole) return { path: "/", aiPanelOpen: true };
  return { path: null, aiPanelOpen: null };
}

export function shouldOpenAIConversationInConsole(
  activeConversationId: string | null,
  messages: readonly { role: string; content?: string; attachments?: readonly unknown[] }[]
): boolean {
  if (!activeConversationId || messages.length === 0) return false;
  return messages.some(
    (message) =>
      message.role === "user" &&
      ((message.content?.trim().length ?? 0) > 0 || (message.attachments?.length ?? 0) > 0)
  );
}

export function resolveAccessibleInterface(
  preferredInterface: "ai_workspace" | "operations_console" | null,
  canUseAIWorkspace: boolean
): "ai_workspace" | "operations_console" | null {
  return canUseAIWorkspace ? preferredInterface : "operations_console";
}

export function resolveAIWorkspaceEntry(
  configured: boolean,
  canUse: boolean,
  canConfigure: boolean,
  enabled: boolean | null
): "open" | AIWorkspaceAvailability {
  if (configured && canUse && enabled !== false) return "open";
  if (configured && !canUse) return "no_access";
  return canConfigure ? "needs_configuration" : "not_configured";
}

/**
 * The empty shell shown while the session, system config or interface
 * preference resolves: nothing appears until the real layout can.
 */
export function ApplicationShellSkeleton({ label = "Loading application" }: { label?: string }) {
  return <div className="fixed inset-0 bg-background" aria-busy="true" aria-label={label} />;
}

export function readSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (parsed >= 200 && parsed <= 480) return parsed;
    }
  } catch {
    // ignore
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

export function persistSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // ignore
  }
}
