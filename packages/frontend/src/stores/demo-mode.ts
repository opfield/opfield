import { create } from "zustand";

export const DEMO_MODE_RESTRICTED = "DEMO_MODE_RESTRICTED";
export const DEMO_CTA_URL = "https://opfield.dev" as const;

interface DemoModeState {
  enabled: boolean;
  open: boolean;
  setEnabled: (enabled: boolean) => void;
  show: () => void;
  close: () => void;
}

export const useDemoModeStore = create<DemoModeState>()((set) => ({
  enabled: false,
  open: false,
  setEnabled: (enabled) => set((state) => ({ enabled, open: enabled ? state.open : false })),
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const READ_ONLY_POST_PATHS = [
  /^\/api\/monitoring\/dashboard\/bootstrap$/,
  /^\/api\/logging\/environments\/[^/]+\/search$/,
  /^\/api\/domains\/preview$/,
  /^\/api\/proxy-hosts\/validate-config$/,
  /^\/api\/nginx-templates\/(?:preview|test)$/,
  /^\/api\/docker\/nodes\/[^/]+\/compose-projects\/validate$/,
  /^\/api\/docker\/folders\/placements$/,
] as const;
const ALWAYS_RESTRICTED_PATHS = [
  /^\/api\/(?:ai|mcp|oauth|inference)(?:\/|$)/,
  /^\/api\/audit(?:\/|$)/,
  /^\/api\/admin\/users\/[^/]+(?:\/|$)/,
  /^\/api\/tokens(?:\/|$)/,
  /\/webhooks?(?:\/|$)/,
  /^\/api\/nodes\/[^/]+\/files(?:\/|$)/,
  /^\/api\/nodes\/[^/]+\/config(?:\/|$)/,
  /^\/api\/docker\/nodes\/[^/]+\/(?:containers\/[^/]+|volumes\/[^/]+)\/files(?:\/|$)/,
  /^\/api\/docker\/nodes\/[^/]+\/containers\/[^/]+\/env(?:\/|$)/,
  /\/(?:exec|console)(?:\/|$)/,
  /\/(?:reveal-credentials|credentials\/reveal|secrets)(?:\/|$)/,
  /\/(?:query|sql)(?:\/|$)/,
  /\/(?:export|download)(?:\/|$)/,
  /\/(?:deploy-?tokens?|logging-?tokens?|tokens?)(?:\/|$)/,
] as const;

export function shouldBlockDemoRequest(path: string, method: string): boolean {
  if (!useDemoModeStore.getState().enabled) return false;
  if (path === "/auth/logout") return false;
  const normalizedMethod = method.toUpperCase();
  if (ALWAYS_RESTRICTED_PATHS.some((pattern) => pattern.test(path))) return true;
  if (SAFE_METHODS.has(normalizedMethod)) return false;
  return !(
    normalizedMethod === "POST" && READ_ONLY_POST_PATHS.some((pattern) => pattern.test(path))
  );
}

export function handleDemoModeApiError(code: string | undefined): boolean {
  if (code !== DEMO_MODE_RESTRICTED) return false;
  useDemoModeStore.getState().show();
  return true;
}
