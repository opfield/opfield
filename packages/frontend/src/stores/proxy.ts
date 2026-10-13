import { create } from "zustand";
import { api } from "@/services/api";
import type { CreateProxyHostRequest, HealthStatus, ProxyHost, ProxyHostType } from "@/types";

interface ProxyHostFilters {
  search: string;
  type: ProxyHostType | "all";
  healthStatus: HealthStatus | "all";
  enabled: "all" | "enabled" | "disabled";
}

interface ProxyState {
  proxyHosts: ProxyHost[];
  selectedProxyHost: ProxyHost | null;
  isLoading: boolean;
  error: string | null;
  filters: ProxyHostFilters;
  page: number;
  limit: number;
  total: number;
  totalPages: number;

  fetchProxyHosts: () => Promise<void>;
  selectProxyHost: (id: string) => Promise<void>;
  clearSelected: () => void;
  createProxyHost: (data: CreateProxyHostRequest) => Promise<ProxyHost>;
  updateProxyHost: (id: string, data: Partial<CreateProxyHostRequest>) => Promise<ProxyHost>;
  deleteProxyHost: (id: string) => Promise<void>;
  toggleProxyHost: (id: string, enabled: boolean) => Promise<void>;
  setFilters: (filters: Partial<ProxyHostFilters>) => void;
  setPage: (page: number) => void;
  resetFilters: () => void;
}

const defaultFilters: ProxyHostFilters = {
  search: "",
  type: "all",
  healthStatus: "all",
  enabled: "all",
};

let fetchProxyHostsRequestId = 0;

export const useProxyStore = create<ProxyState>()((set, get) => ({
  proxyHosts: [],
  selectedProxyHost: null,
  isLoading: false,
  error: null,
  filters: { ...defaultFilters },
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 0,

  fetchProxyHosts: async () => {
    const requestId = ++fetchProxyHostsRequestId;
    const { filters, page, limit } = get();
    set({ isLoading: true, error: null });
    try {
      const response = await api.listProxyHosts({
        page,
        limit,
        search: filters.search || undefined,
        type: filters.type !== "all" ? filters.type : undefined,
        healthStatus: filters.healthStatus !== "all" ? filters.healthStatus : undefined,
        enabled: filters.enabled !== "all" ? filters.enabled === "enabled" : undefined,
      });
      if (requestId !== fetchProxyHostsRequestId) return;
      set({
        proxyHosts: response.data || [],
        total: response.pagination?.total ?? 0,
        totalPages: response.pagination?.totalPages ?? 0,
        isLoading: false,
      });
    } catch (err) {
      if (requestId !== fetchProxyHostsRequestId) return;
      const message = err instanceof Error ? err.message : "Failed to fetch routes";
      set({ error: message, isLoading: false });
    }
  },

  selectProxyHost: async (id: string) => {
    const existing = get().proxyHosts.find((h) => h.id === id);
    if (existing) {
      set({ selectedProxyHost: existing });
    }
    try {
      const host = await api.getProxyHost(id);
      set({ selectedProxyHost: host });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch route";
      set({ error: message });
    }
  },

  clearSelected: () => set({ selectedProxyHost: null }),

  createProxyHost: async (data: CreateProxyHostRequest) => {
    const host = await api.createProxyHost(data);
    get().fetchProxyHosts();
    return host;
  },

  updateProxyHost: async (id: string, data: Partial<CreateProxyHostRequest>) => {
    const host = await api.updateProxyHost(id, data);
    set((state) => ({
      proxyHosts: state.proxyHosts.map((h) => (h.id === id ? host : h)),
      selectedProxyHost: state.selectedProxyHost?.id === id ? host : state.selectedProxyHost,
    }));
    return host;
  },

  deleteProxyHost: async (id: string) => {
    await api.deleteProxyHost(id);
    set((state) => ({
      proxyHosts: state.proxyHosts.filter((h) => h.id !== id),
      selectedProxyHost: state.selectedProxyHost?.id === id ? null : state.selectedProxyHost,
    }));
  },

  toggleProxyHost: async (id: string, enabled: boolean) => {
    const host = await api.toggleProxyHost(id, enabled);
    set((state) => ({
      proxyHosts: state.proxyHosts.map((h) => (h.id === id ? host : h)),
      selectedProxyHost: state.selectedProxyHost?.id === id ? host : state.selectedProxyHost,
    }));
  },

  setFilters: (newFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
      page: 1,
    }));
    get().fetchProxyHosts();
  },

  setPage: (page) => {
    set({ page });
    get().fetchProxyHosts();
  },

  resetFilters: () => {
    set({ filters: { ...defaultFilters }, page: 1 });
    get().fetchProxyHosts();
  },
}));
