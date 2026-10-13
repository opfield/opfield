import { create } from "zustand";
import { hasScopeBase, scopeMatches } from "@/lib/scope-utils";
import { useUIStore } from "@/stores/ui";
import type { User } from "@/types";

export interface AuthContextResetOptions {
  preserveShell?: boolean;
}
type AuthContextResetCallback = (options?: AuthContextResetOptions) => void;

let authContextResetCallback: AuthContextResetCallback | null = null;
export const AUTH_CONTEXT_STORAGE_KEY = "opfield-auth-context-key";

export function registerAuthContextReset(callback: AuthContextResetCallback) {
  authContextResetCallback = callback;
}

/**
 * Identifies what the signed-in person may see for UI that must restart when it changes: the
 * page outlet and stale-response checks. It changes when the user changes or a grant is lost, but
 * not when live scopes only widen, so a folder grant resolving a new resource never remounts the
 * page the person is looking at.
 */
export function accessContextKey(state: { user: User | null; accessEpoch: number }): string {
  return state.user ? `${state.user.id}:${state.accessEpoch}` : "anonymous";
}

export function authContextKey(user: User | null): string {
  if (!user) return "anonymous";
  return `${user.id}:${[...user.scopes].sort().join(",")}:${user.isBlocked ? "blocked" : "active"}`;
}

function getStoredAuthContextKey(): string | null {
  try {
    return window.localStorage.getItem(AUTH_CONTEXT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredAuthContextKey(key: string): void {
  try {
    window.localStorage.setItem(AUTH_CONTEXT_STORAGE_KEY, key);
  } catch {
    // Storage may be unavailable in private or embedded contexts.
  }
}

function clearStoredAuthContextKey(): void {
  try {
    window.localStorage.removeItem(AUTH_CONTEXT_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in private or embedded contexts.
  }
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Bumped when the user changes or loses a grant; see accessContextKey. */
  accessEpoch: number;

  setUser: (user: User | null) => void;
  /** Apply live effective scopes pushed by the events socket (`{ type: "permissions" }`). */
  applyLiveScopes: (scopes: readonly string[]) => void;
  setLoading: (loading: boolean) => void;
  login: (user: User) => void;
  logout: () => void;
  hasScope: (scope: string) => boolean;
  hasScopedAccess: (scopeBase: string) => boolean;
  hasAnyScope: (...scopes: string[]) => boolean;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  accessEpoch: 0,

  setUser: (user) => {
    const currentUser = get().user;
    if (!user) {
      if (currentUser) {
        authContextResetCallback?.();
      }
      clearStoredAuthContextKey();
    } else {
      const nextKey = authContextKey(user);
      const currentKey = currentUser ? authContextKey(currentUser) : getStoredAuthContextKey();
      if (currentKey && currentKey !== nextKey) {
        // Same-account permission changes invalidate private data, not the user's chosen interface.
        authContextResetCallback?.({
          preserveShell: currentUser?.id === user.id && !currentUser.isBlocked && !user.isBlocked,
        });
      }
      setStoredAuthContextKey(nextKey);
      if (user.aiApprovalMode) useUIStore.getState().hydrateAIApprovalMode(user.aiApprovalMode);
    }
    const accessChanged =
      !user ||
      !currentUser ||
      currentUser.id !== user.id ||
      authContextKey(currentUser) !== authContextKey(user);
    set({
      user,
      isAuthenticated: !!user,
      accessEpoch: accessChanged ? get().accessEpoch + 1 : get().accessEpoch,
    });
  },

  applyLiveScopes: (scopes) => {
    const currentUser = get().user;
    if (!currentUser) return;
    const current = new Set(currentUser.scopes);
    const nextSet = new Set(scopes);
    const next = [...nextSet];
    if (next.length === current.size && next.every((scope) => current.has(scope))) return;
    const nextUser = { ...currentUser, scopes: next };
    const onlyAdded = [...current].every((scope) => nextSet.has(scope));
    if (!onlyAdded) {
      // A lost grant invalidates private data, exactly like a permission change event.
      get().setUser(nextUser);
      return;
    }
    // Folder and node grants now cover resources that were created or moved in: widen in place
    // so they become usable without reloading or resetting session state.
    setStoredAuthContextKey(authContextKey(nextUser));
    set({ user: nextUser });
  },

  setLoading: (isLoading) => set({ isLoading }),

  login: (user) => {
    const currentUser = get().user;
    const nextKey = authContextKey(user);
    const currentKey = currentUser ? authContextKey(currentUser) : getStoredAuthContextKey();
    if (currentKey && currentKey !== nextKey) {
      authContextResetCallback?.();
    }
    setStoredAuthContextKey(nextKey);
    if (user.aiApprovalMode) useUIStore.getState().hydrateAIApprovalMode(user.aiApprovalMode);
    set({
      user,
      isAuthenticated: true,
      isLoading: false,
      accessEpoch: get().accessEpoch + 1,
    });
  },

  logout: () => {
    const hasStoredContext = !!getStoredAuthContextKey();
    if (get().user || get().isAuthenticated || hasStoredContext) {
      authContextResetCallback?.();
    }
    clearStoredAuthContextKey();
    set({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
  },

  hasScope: (scope) => {
    const user = get().user;
    if (!user) return false;
    return scopeMatches(user.scopes, scope);
  },

  hasScopedAccess: (scopeBase) => {
    const user = get().user;
    if (!user) return false;
    return hasScopeBase(user.scopes, scopeBase);
  },

  hasAnyScope: (...scopes) => {
    const user = get().user;
    if (!user) return false;
    return scopes.some((s) => scopeMatches(user.scopes, s));
  },
}));
