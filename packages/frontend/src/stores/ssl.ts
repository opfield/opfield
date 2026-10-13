import { create } from "zustand";
import { NORMAL_LIST_FILTER } from "@/lib/app-members";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import type {
  LinkInternalCertRequest,
  RequestACMECertRequest,
  SSLCertificate,
  SSLCertificateOperationResult,
  SSLCertStatus,
  SSLCertType,
  UploadCertRequest,
} from "@/types";

interface SSLCertFilters {
  search: string;
  type: SSLCertType | "all";
  status: SSLCertStatus | "all";
}

interface SSLState {
  certificates: SSLCertificate[];
  selectedCert: SSLCertificate | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  filters: SSLCertFilters;
  limit: number;
  total: number;
  hasMore: boolean;
  nextPage: number;

  fetchCertificates: () => Promise<void>;
  fetchNextPage: () => Promise<void>;
  selectCertificate: (id: string) => Promise<void>;
  clearSelected: () => void;
  requestACME: (data: RequestACMECertRequest) => Promise<SSLCertificateOperationResult>;
  uploadCert: (data: UploadCertRequest) => Promise<SSLCertificate>;
  linkInternal: (data: LinkInternalCertRequest) => Promise<SSLCertificate>;
  renewCert: (id: string) => Promise<SSLCertificate | SSLCertificateOperationResult>;
  setAutoRenew: (
    id: string,
    data: { enabled: boolean; provider?: "cloudflare" }
  ) => Promise<SSLCertificate>;
  deleteCert: (id: string) => Promise<void>;
  completeDNSVerify: (id: string) => Promise<SSLCertificate>;
  setFilters: (filters: Partial<SSLCertFilters>) => void;
  resetFilters: () => void;
}

const defaultFilters: SSLCertFilters = {
  search: "",
  type: "all",
  status: "active",
};

let fetchSSLCertificatesRequestId = 0;

export const useSSLStore = create<SSLState>()((set, get) => ({
  certificates: [],
  selectedCert: null,
  isLoading: true,
  isLoadingMore: false,
  error: null,
  filters: { ...defaultFilters },
  limit: 25,
  total: 0,
  hasMore: false,
  nextPage: 1,

  fetchCertificates: async () => {
    const requestId = ++fetchSSLCertificatesRequestId;
    const { filters, limit } = get();
    const showSystem =
      useUIStore.getState().showSystemCertificates &&
      useAuthStore.getState().hasScope("admin:details:certificates");
    const isDefault = !filters.search && filters.type === "all" && filters.status === "active";
    const cacheKey = `ssl:list:${showSystem ? "system" : "default"}`;

    // Show cached data instantly for default view
    const cached = isDefault
      ? api.getCached<{
          data: SSLCertificate[];
          pagination: { total: number; totalPages: number };
        }>(cacheKey)
      : undefined;
    const hasCachedSnapshot = cached !== undefined;
    if (get().certificates.length === 0 && cached) {
      set({
        certificates: cached.data || [],
        total: cached.pagination?.total ?? 0,
        hasMore: (cached.pagination?.totalPages ?? 0) > 1,
        nextPage: 2,
      });
    }

    const hasData = get().certificates.length > 0;
    set({ isLoading: !hasCachedSnapshot && !hasData, isLoadingMore: false, error: null });
    try {
      const response = await api.listSSLCertificates({
        page: 1,
        limit,
        search: filters.search || undefined,
        type: filters.type !== "all" ? filters.type : undefined,
        status: filters.status !== "all" ? filters.status : undefined,
        showSystem,
        // App members live on their app's page: the server leaves them out.
        ...NORMAL_LIST_FILTER,
      });
      if (requestId !== fetchSSLCertificatesRequestId) return;
      if (isDefault) api.setCache(cacheKey, response);
      set({
        certificates: response.data || [],
        total: response.pagination?.total ?? 0,
        hasMore: (response.pagination?.page ?? 1) < (response.pagination?.totalPages ?? 0),
        nextPage: (response.pagination?.page ?? 1) + 1,
        isLoading: false,
        isLoadingMore: false,
      });
    } catch (err) {
      if (requestId !== fetchSSLCertificatesRequestId) return;
      const message = err instanceof Error ? err.message : "Failed to fetch SSL certificates";
      set({ error: message, isLoading: false, isLoadingMore: false });
    }
  },

  fetchNextPage: async () => {
    const { filters, limit, hasMore, isLoading, isLoadingMore, nextPage } = get();
    if (!hasMore || isLoading || isLoadingMore) return;

    const requestId = ++fetchSSLCertificatesRequestId;
    const showSystem =
      useUIStore.getState().showSystemCertificates &&
      useAuthStore.getState().hasScope("admin:details:certificates");
    set({ isLoadingMore: true, error: null });
    try {
      const response = await api.listSSLCertificates({
        page: nextPage,
        limit,
        search: filters.search || undefined,
        type: filters.type !== "all" ? filters.type : undefined,
        status: filters.status !== "all" ? filters.status : undefined,
        showSystem,
        // App members live on their app's page: the server leaves them out.
        ...NORMAL_LIST_FILTER,
      });
      if (requestId !== fetchSSLCertificatesRequestId) return;
      set((state) => {
        const knownIds = new Set(state.certificates.map((certificate) => certificate.id));
        const nextCertificates = (response.data || []).filter(
          (certificate) => !knownIds.has(certificate.id)
        );
        return {
          certificates: [...state.certificates, ...nextCertificates],
          total: response.pagination?.total ?? state.total,
          hasMore: (response.pagination?.page ?? nextPage) < (response.pagination?.totalPages ?? 0),
          nextPage: (response.pagination?.page ?? nextPage) + 1,
          isLoadingMore: false,
        };
      });
    } catch (err) {
      if (requestId !== fetchSSLCertificatesRequestId) return;
      const message = err instanceof Error ? err.message : "Failed to fetch more SSL certificates";
      set({ error: message, isLoadingMore: false });
    }
  },

  selectCertificate: async (id: string) => {
    const existing = get().certificates.find((c) => c.id === id);
    if (existing) {
      set({ selectedCert: existing });
    }
    try {
      const cert = await api.getSSLCertificate(id);
      set({ selectedCert: cert });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch SSL certificate";
      set({ error: message });
    }
  },

  clearSelected: () => set({ selectedCert: null }),

  requestACME: async (data: RequestACMECertRequest) => {
    const result = await api.requestACMECert(data);
    get().fetchCertificates();
    return result;
  },

  uploadCert: async (data: UploadCertRequest) => {
    const cert = await api.uploadCert(data);
    get().fetchCertificates();
    return cert;
  },

  linkInternal: async (data: LinkInternalCertRequest) => {
    const cert = await api.linkInternalCert(data);
    get().fetchCertificates();
    return cert;
  },

  renewCert: async (id: string) => {
    const result = await api.renewSSLCert(id);
    const cert = "certificate" in result ? result.certificate : result;
    set((state) => ({
      certificates: state.certificates.map((c) => (c.id === id ? cert : c)),
      selectedCert: state.selectedCert?.id === id ? cert : state.selectedCert,
    }));
    return result;
  },

  setAutoRenew: async (id, data) => {
    const cert = await api.setSSLCertAutoRenew(id, data);
    set((state) => ({
      certificates: state.certificates.map((c) => (c.id === id ? cert : c)),
      selectedCert: state.selectedCert?.id === id ? cert : state.selectedCert,
    }));
    return cert;
  },

  deleteCert: async (id: string) => {
    await api.deleteSSLCert(id);
    set((state) => ({
      certificates: state.certificates.filter((c) => c.id !== id),
      selectedCert: state.selectedCert?.id === id ? null : state.selectedCert,
      total: Math.max(0, state.total - 1),
    }));
  },

  completeDNSVerify: async (id: string) => {
    const cert = await api.completeDNSVerify(id);
    set((state) => ({
      certificates: state.certificates.map((c) => (c.id === id ? cert : c)),
      selectedCert: state.selectedCert?.id === id ? cert : state.selectedCert,
    }));
    return cert;
  },

  setFilters: (newFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
      certificates: [],
      hasMore: false,
      nextPage: 1,
      isLoadingMore: false,
    }));
    get().fetchCertificates();
  },

  resetFilters: () => {
    set({
      filters: { ...defaultFilters },
      certificates: [],
      hasMore: false,
      nextPage: 1,
      isLoadingMore: false,
    });
    get().fetchCertificates();
  },
}));
