import { create } from "zustand";
import { persist } from "zustand/middleware";
import { LEGACY_STORAGE_KEY_PREFIX } from "../../../backend/src/lib/legacy-compat";

export const APP_STATUS_STORAGE_KEY = "opfield-app-status";
// legacy-name: app status key the 2.12.0 bundle in open tabs writes during the update — remove once 2.12.0 is no longer an update source
export const LEGACY_APP_STATUS_STORAGE_KEY = `${LEGACY_STORAGE_KEY_PREFIX}-app-status`;

export interface OpfieldUpdateError {
  message: string;
  targetVersion: string | null;
  /** The update restarted Opfield, which came back on the previous version. */
  rolledBack?: boolean;
}

interface AppStatusState {
  maintenanceActive: boolean;
  opfieldUpdatingActive: boolean;
  opfieldUpdatingTargetVersion: string | null;
  /** When this browser entered the update screen (epoch ms); bounds how long it waits. */
  opfieldUpdatingStartedAt: number | null;
  opfieldRestartingActive: boolean;
  opfieldRestartTargetUrl: string | null;
  opfieldUpdateError: OpfieldUpdateError | null;
  rateLimitedUntil: number | null;
  setMaintenanceActive: (active: boolean) => void;
  setOpfieldUpdatingActive: (active: boolean, targetVersion?: string | null) => void;
  setOpfieldRestartingActive: (active: boolean, targetUrl?: string | null) => void;
  setOpfieldUpdateError: (
    message: string,
    targetVersion?: string | null,
    options?: { rolledBack?: boolean }
  ) => void;
  clearOpfieldUpdating: () => void;
  clearOpfieldRestarting: () => void;
  clearOpfieldUpdateError: () => void;
  activateRateLimit: (seconds?: number) => void;
  clearRateLimit: () => void;
}

export const useAppStatusStore = create<AppStatusState>()(
  persist(
    (set) => ({
      maintenanceActive: false,
      opfieldUpdatingActive: false,
      opfieldUpdatingTargetVersion: null,
      opfieldUpdatingStartedAt: null,
      opfieldRestartingActive: false,
      opfieldRestartTargetUrl: null,
      opfieldUpdateError: null,
      rateLimitedUntil: null,

      setMaintenanceActive: (maintenanceActive) =>
        set((state) => {
          if (maintenanceActive && (state.opfieldUpdatingActive || state.opfieldRestartingActive)) {
            return {};
          }
          return { maintenanceActive };
        }),

      setOpfieldUpdatingActive: (opfieldUpdatingActive, opfieldUpdatingTargetVersion = null) =>
        set((state) => ({
          opfieldUpdatingActive,
          opfieldUpdatingTargetVersion,
          // Re-announcing the same update keeps its start; a new one starts the clock.
          opfieldUpdatingStartedAt: opfieldUpdatingActive
            ? state.opfieldUpdatingActive &&
              state.opfieldUpdatingStartedAt != null &&
              (state.opfieldUpdatingTargetVersion === opfieldUpdatingTargetVersion ||
                opfieldUpdatingTargetVersion == null)
              ? state.opfieldUpdatingStartedAt
              : Date.now()
            : null,
          opfieldRestartingActive: false,
          opfieldRestartTargetUrl: null,
          opfieldUpdateError: null,
          ...(opfieldUpdatingActive ? { maintenanceActive: false } : {}),
        })),

      setOpfieldRestartingActive: (opfieldRestartingActive, opfieldRestartTargetUrl = null) =>
        set((state) => {
          if (opfieldRestartingActive && state.opfieldUpdatingActive) return {};
          return {
            opfieldRestartingActive,
            opfieldRestartTargetUrl,
            opfieldUpdateError: null,
            ...(opfieldRestartingActive ? { maintenanceActive: false } : {}),
          };
        }),

      setOpfieldUpdateError: (message, targetVersion = null, options = {}) =>
        set({
          opfieldUpdatingActive: false,
          opfieldUpdatingTargetVersion: null,
          opfieldUpdatingStartedAt: null,
          opfieldRestartingActive: false,
          opfieldRestartTargetUrl: null,
          opfieldUpdateError: {
            message,
            targetVersion,
            ...(options.rolledBack ? { rolledBack: true } : {}),
          },
        }),

      clearOpfieldUpdating: () =>
        set({
          opfieldUpdatingActive: false,
          opfieldUpdatingTargetVersion: null,
          opfieldUpdatingStartedAt: null,
        }),

      clearOpfieldRestarting: () =>
        set({ opfieldRestartingActive: false, opfieldRestartTargetUrl: null }),

      clearOpfieldUpdateError: () => set({ opfieldUpdateError: null }),

      activateRateLimit: (seconds = 60) =>
        set({
          rateLimitedUntil: Date.now() + Math.max(1, seconds) * 1000,
        }),

      clearRateLimit: () => set({ rateLimitedUntil: null }),
    }),
    {
      name: APP_STATUS_STORAGE_KEY,
      partialize: (state) => ({
        opfieldUpdatingActive: state.opfieldUpdatingActive,
        opfieldUpdatingTargetVersion: state.opfieldUpdatingTargetVersion,
        opfieldUpdatingStartedAt: state.opfieldUpdatingStartedAt,
        opfieldRestartingActive: state.opfieldRestartingActive,
        opfieldRestartTargetUrl: state.opfieldRestartTargetUrl,
      }),
    }
  )
);

interface OpfieldOperationStatusSnapshot {
  opfieldUpdatingActive: boolean;
  opfieldUpdatingTargetVersion: string | null;
  opfieldRestartingActive: boolean;
  opfieldRestartTargetUrl: string | null;
}

export function syncOpfieldOperationStatus(snapshot: OpfieldOperationStatusSnapshot): boolean {
  const current = useAppStatusStore.getState();
  if (
    current.opfieldUpdatingActive === snapshot.opfieldUpdatingActive &&
    current.opfieldUpdatingTargetVersion === snapshot.opfieldUpdatingTargetVersion &&
    current.opfieldRestartingActive === snapshot.opfieldRestartingActive &&
    current.opfieldRestartTargetUrl === snapshot.opfieldRestartTargetUrl
  ) {
    return false;
  }

  useAppStatusStore.setState({
    ...snapshot,
    opfieldUpdatingStartedAt: snapshot.opfieldUpdatingActive
      ? (current.opfieldUpdatingStartedAt ?? Date.now())
      : null,
    ...(snapshot.opfieldUpdatingActive || snapshot.opfieldRestartingActive
      ? { maintenanceActive: false }
      : {}),
  });
  return true;
}
