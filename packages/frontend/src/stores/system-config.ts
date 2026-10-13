import { create } from "zustand";
import { api } from "@/services/api";
import type { OpfieldFeatureConfig, SystemConfig } from "@/types";

const BYTES_PER_MEGABYTE = 1024 * 1024;

export const DEFAULT_OPFIELD_FEATURES: OpfieldFeatureConfig = {
  pkiEnabled: true,
  domainsEnabled: true,
  siemEnabled: true,
  loggingEnabled: false,
  inferenceEnabled: false,
};

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  fileUploadMaxBytes: 100 * BYTES_PER_MEGABYTE,
  fileOpenMaxBytes: 10 * BYTES_PER_MEGABYTE,
  grpcPublicTarget: null,
  grpcLocalIp: null,
  relayAutoRecovery: true,
  features: DEFAULT_OPFIELD_FEATURES,
};

const cachedSystemConfig = api.getCached<SystemConfig>("system:config");
let systemConfigLoadPromise: Promise<SystemConfig> | null = null;

export function withDefaultSystemConfig(
  config: Partial<SystemConfig> | null | undefined
): SystemConfig {
  return {
    ...DEFAULT_SYSTEM_CONFIG,
    ...config,
    features: {
      ...DEFAULT_OPFIELD_FEATURES,
      ...config?.features,
    },
  };
}

interface SystemConfigState {
  config: SystemConfig;
  isLoading: boolean;
  loaded: boolean;
  load: () => Promise<SystemConfig>;
  setConfig: (config: Partial<SystemConfig>) => void;
  reset: () => void;
}

export const useSystemConfigStore = create<SystemConfigState>((set) => ({
  config: withDefaultSystemConfig(cachedSystemConfig ?? null),
  isLoading: false,
  loaded: cachedSystemConfig !== undefined,
  load: async () => {
    if (systemConfigLoadPromise) return systemConfigLoadPromise;
    set({ isLoading: true });
    systemConfigLoadPromise = api
      .getSystemConfig()
      .then((value) => {
        const config = withDefaultSystemConfig(value);
        api.setCache("system:config", config);
        set({ config, isLoading: false, loaded: true });
        return config;
      })
      .catch((error) => {
        set({ isLoading: false });
        throw error;
      })
      .finally(() => {
        systemConfigLoadPromise = null;
      });
    return systemConfigLoadPromise;
  },
  setConfig: (config) => {
    const next = withDefaultSystemConfig(config);
    api.setCache("system:config", next);
    set({ config: next, loaded: true });
  },
  reset: () => {
    systemConfigLoadPromise = null;
    set({ config: DEFAULT_SYSTEM_CONFIG, isLoading: false, loaded: false });
  },
}));
