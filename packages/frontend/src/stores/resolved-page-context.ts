import { useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";

export type ResolvedPageResourceType =
  | "node"
  | "database"
  | "storage"
  | "proxy-host"
  | "logging-environment"
  | "logging-schema"
  | "docker-container"
  | "docker-deployment"
  | "docker-volume"
  | "docker-compose-project"
  | "page-project"
  | "app"
  | "app-environment"
  | "ingress-group"
  | "ca"
  | "certificate";

export interface ResolvedPageResource {
  resourceType: ResolvedPageResourceType;
  resourceId: string;
  nodeId?: string;
  scopeResourceId?: string;
  label?: string;
}

interface ResolvedPageContextState {
  ownerToken: number;
  routeKey: string | null;
  status: "idle" | "resolving" | "ready";
  resource: ResolvedPageResource | null;
  begin: (routeKey: string) => number;
  resolve: (token: number, resource: ResolvedPageResource) => void;
  fail: (token: number) => void;
  clear: (token: number) => void;
}

export const useResolvedPageContext = create<ResolvedPageContextState>()((set, get) => ({
  ownerToken: 0,
  routeKey: null,
  status: "idle",
  resource: null,
  begin: (routeKey) => {
    const ownerToken = get().ownerToken + 1;
    set({ ownerToken, routeKey, status: "resolving", resource: null });
    return ownerToken;
  },
  resolve: (token, resource) => {
    if (get().ownerToken === token) set({ status: "ready", resource });
  },
  fail: (token) => {
    if (get().ownerToken === token) set({ status: "idle", resource: null });
  },
  clear: (token) => {
    if (get().ownerToken === token) set({ routeKey: null, status: "idle", resource: null });
  },
}));

export function useResolvedPageRoute<T>(
  routeKey: string | undefined,
  resolver: () => Promise<T>,
  toResource: (data: T) => ResolvedPageResource
) {
  const resolverRef = useRef(resolver);
  const toResourceRef = useRef(toResource);
  resolverRef.current = resolver;
  toResourceRef.current = toResource;
  const [result, setResult] = useState<{
    routeKey: string | null;
    token: number | null;
    data: T | null;
    error: unknown;
  }>({ routeKey: null, token: null, data: null, error: null });

  useLayoutEffect(() => {
    if (!routeKey) {
      setResult({ routeKey: null, token: null, data: null, error: null });
      return;
    }

    const token = useResolvedPageContext.getState().begin(routeKey);
    let active = true;
    setResult({ routeKey, token, data: null, error: null });
    void resolverRef
      .current()
      .then((data) => {
        if (!active || useResolvedPageContext.getState().ownerToken !== token) return;
        useResolvedPageContext.getState().resolve(token, toResourceRef.current(data));
        setResult({ routeKey, token, data, error: null });
      })
      .catch((error) => {
        if (!active || useResolvedPageContext.getState().ownerToken !== token) return;
        useResolvedPageContext.getState().fail(token);
        setResult({ routeKey, token, data: null, error });
      });

    return () => {
      active = false;
      useResolvedPageContext.getState().clear(token);
    };
  }, [routeKey]);

  const current = result.routeKey === routeKey ? result : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: !!routeKey && (!current || (!current.data && !current.error)),
    ownerToken: current?.token ?? null,
  };
}

/**
 * Publishes a resource a page has already loaded as the page's AI context, for pages without a
 * resolving guard. Pass null until the resource is loaded; the publication ends on unmount.
 */
export function usePublishedPageResource(
  routeKey: string | undefined,
  resource: ResolvedPageResource | null
) {
  const resourceRef = useRef(resource);
  resourceRef.current = resource;
  const identity = resource
    ? [
        resource.resourceType,
        resource.resourceId,
        resource.label ?? "",
        resource.nodeId ?? "",
        resource.scopeResourceId ?? "",
      ].join("\u0000")
    : null;

  useLayoutEffect(() => {
    const current = resourceRef.current;
    if (!routeKey || !identity || !current) return;
    const store = useResolvedPageContext.getState();
    const token = store.begin(routeKey);
    store.resolve(token, current);
    return () => useResolvedPageContext.getState().clear(token);
  }, [routeKey, identity]);
}
