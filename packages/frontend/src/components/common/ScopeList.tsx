import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useContentLoading } from "@/components/common/reveal-gate";
import type { ScopeSelectionFilter } from "@/components/common/ScopeSearchFilter";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import type {
  CA,
  DatabaseConnection,
  Domain,
  LoggingEnvironment,
  LoggingSchema,
  Node,
  ProxyHost,
} from "@/types";
import { GitScopeRestriction } from "./GitScopeRestriction";
import {
  canLoadGitScopeTargets,
  GIT_PROVIDER_LABELS,
  type GitScopeConnectorCatalog,
  type GitScopeProvider,
  type GitTargetLabel,
  type GitTargetLabels,
  gitLabelKey,
  gitQualifierLabel,
  gitScopeProvider,
  gitScopeTargetKinds,
  loadGitScopeConnectors,
  parseGitQualifier,
  planGitRestrictionCopy,
  resolveGitTargetLabels,
} from "./git-scope-targets";
import {
  APP_FAMILY_FOLDER_FAMILY,
  APP_SCOPE_PREFIX,
  type AppScopeApp,
  allResourcePages,
  appFolderOptions,
  appScopeResourceOptions,
  canLoadScopeResource,
  type DockerResourceOption,
  type FolderFamily,
  type FolderOption,
  folderFamilyForScope,
  folderTarget,
  getResourceLabel,
  getResourceOptions,
  isFolderTarget,
  loadAppScopeCatalog,
  loadFolderFamily,
  loadScopeResourceCatalog,
  matchesQuery,
  parseScopedSelections,
  type RestrictionRow,
  reportScopeLoadError,
  type ScopeItem,
  type ScopeResourceCatalog,
} from "./scope-list-helpers";

export type { ScopeItem } from "./scope-list-helpers";

const APP_FOLDER_FAMILIES = new Set<FolderFamily>(Object.values(APP_FAMILY_FOLDER_FAMILY));

/**
 * Whether the selection needs the apps: an app scope is picked (its restriction lists apps and
 * environments), or a grant names a folder no folder tree lists in a family app environments keep
 * hidden folders in ("Shop · staging" instead of a folder ID).
 */
function selectionNeedsApps(
  scopes: readonly ScopeItem[],
  selected: readonly string[],
  restrictions: readonly (Record<string, string[]> | undefined)[],
  knownFolderTargets: ReadonlySet<string>
) {
  if (
    scopes.some(
      (scope) => scope.value.startsWith(APP_SCOPE_PREFIX) && selected.includes(scope.value)
    )
  )
    return true;
  return restrictions.some((byScope) =>
    Object.entries(byScope ?? {}).some(([scope, ids]) => {
      if (scope.startsWith(APP_SCOPE_PREFIX)) return ids.length > 0;
      const family = folderFamilyForScope(scope);
      return (
        !!family &&
        APP_FOLDER_FAMILIES.has(family) &&
        ids.some((id) => isFolderTarget(id) && !knownFolderTargets.has(id))
      );
    })
  );
}

interface ScopeListProps {
  scopes: readonly ScopeItem[];
  search: string;
  selected: string[];
  onToggle: (scope: string) => void;
  resources?: Record<string, string[]>;
  onToggleResource?: (scope: string, resourceId: string) => void;
  cas?: CA[];
  nodes?: Node[];
  proxyHosts?: ProxyHost[];
  databases?: DatabaseConnection[];
  loggingSchemas?: LoggingSchema[];
  restrictableScopes?: readonly string[];
  allowedResourceIds?: Record<string, string[]>;
  inheritedScopes?: string[];
  inheritedFromName?: string;
  readOnly?: boolean;
  viewportClassName?: string;
  selectionFilter?: ScopeSelectionFilter;
  /**
   * Keep each restriction tree behind a one-line summary ("All resources · Restrict…") until the
   * user opens it (the default everywhere; read-only lists offer "Show").
   */
  collapsedRestrictions?: boolean;
  /** Receives the folders loaded for the selected scopes' folder families. */
  onFolderOptionsChange?: (options: FolderOption[]) => void;
  /**
   * Replaces the restrictions of several scopes at once. Enables "Apply to the other Git
   * scopes in this section" on a restricted Git scope row.
   */
  onResourcesChange?: (resources: Record<string, string[]>) => void;
  /**
   * Called once, when the option lists and labels the first render depends on have loaded.
   * For screens outside a reveal gate (OAuth consent); gated screens use `useContentLoading`.
   */
  onInitialLoadComplete?: () => void;
}

export function ScopeList({
  scopes,
  search,
  selected,
  onToggle,
  resources,
  onToggleResource,
  cas,
  nodes,
  proxyHosts,
  databases,
  loggingSchemas,
  restrictableScopes,
  allowedResourceIds,
  inheritedScopes,
  inheritedFromName,
  readOnly,
  viewportClassName,
  selectionFilter = "all",
  collapsedRestrictions = true,
  onFolderOptionsChange,
  onInitialLoadComplete,
  onResourcesChange,
}: ScopeListProps) {
  const actorScopes = useAuthStore((state) => state.user?.scopes);
  const [expandedScopes, setExpandedScopes] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = (scope: string) =>
    setExpandedScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  const features = useSystemConfigStore((state) => state.config.features);
  const [dockerResources, setDockerResources] = useState<DockerResourceOption[]>([]);
  const [resourceCatalog, setResourceCatalog] = useState<ScopeResourceCatalog>({});
  // The first load of each option list holds the enclosing dialog or page, so
  // restriction rows do not change after it appears. Later reloads (another
  // scope selected, fresh grants) update in place without being reported.
  const [catalogReady, setCatalogReady] = useState(false);
  const [foldersReady, setFoldersReady] = useState(false);
  const [dockerReady, setDockerReady] = useState(false);
  const [registriesReady, setRegistriesReady] = useState(false);
  const [gitConnectorsReady, setGitConnectorsReady] = useState(false);
  const [apps, setApps] = useState<AppScopeApp[]>([]);
  const [appsReady, setAppsReady] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Lookup helpers read current auth/features from stores; rerun and cancel old loads when either changes.
  useEffect(() => {
    let cancelled = false;
    void loadScopeResourceCatalog(scopes, nodes ?? [])
      .then((catalog) => {
        if (!cancelled) setResourceCatalog(catalog);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setCatalogReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [scopes, nodes, actorScopes, features]);
  const [dockerRegistryRepositories, setDockerRegistryRepositories] = useState<string[]>([]);
  const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
  const [domainResources, setDomainResources] = useState<Domain[]>([]);
  const [loggingEnvironments, setLoggingEnvironments] = useState<LoggingEnvironment[]>([]);
  const q = search.toLowerCase().trim();
  const inheritedParsed = parseScopedSelections(inheritedScopes ?? [], restrictableScopes ?? []);
  const inheritedBaseSet = new Set(inheritedParsed.baseScopes);
  // Decided once the folder trees are known; the first load holds the reveal like the others.
  const needsApps =
    foldersReady &&
    selectionNeedsApps(
      scopes,
      [...selected, ...inheritedParsed.baseScopes],
      [resources, inheritedParsed.resources, allowedResourceIds],
      new Set(folderOptions.map((folder) => folderTarget(folder.id)))
    );

  // biome-ignore lint/correctness/useExhaustiveDependencies: The lookup permission helper reads the actor's current scopes from the store.
  useEffect(() => {
    if (!foldersReady) return;
    if (!needsApps) {
      setAppsReady(true);
      return;
    }
    let cancelled = false;
    void loadAppScopeCatalog()
      .then((loaded) => {
        if (!cancelled) setApps(loaded);
      })
      .finally(() => {
        if (!cancelled) setAppsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [foldersReady, needsApps, actorScopes]);
  const rowCatalog = useMemo<ScopeResourceCatalog>(
    () =>
      apps.length > 0
        ? { ...resourceCatalog, apps: appScopeResourceOptions(apps) }
        : resourceCatalog,
    [apps, resourceCatalog]
  );
  const rowFolderOptions = useMemo(
    () => (apps.length > 0 ? [...folderOptions, ...appFolderOptions(apps)] : folderOptions),
    [apps, folderOptions]
  );

  // Git scopes: connectors per provider, and labels for stored group/project/owner/repo
  // qualifiers (selected, inherited, or held by the granting user).
  const [gitConnectors, setGitConnectors] = useState<GitScopeConnectorCatalog>({});
  const [gitLabels, setGitLabels] = useState<GitTargetLabels>({});
  const [gitLabelFailures, setGitLabelFailures] = useState<ReadonlySet<string>>(() => new Set());
  const gitLabelsInFlight = useRef(new Set<string>());
  const gitScopes = scopes.flatMap((scope) => {
    const provider = restrictableScopes?.includes(scope.value)
      ? gitScopeProvider(scope.value)
      : null;
    return provider ? [{ scope: scope.value, provider }] : [];
  });
  const gitProvidersKey = [...new Set(gitScopes.map(({ provider }) => provider))].sort().join(",");
  const pendingGitLabelKeys = [
    ...new Set(
      gitScopes.flatMap(({ scope, provider }) =>
        gitScopeTargetKinds(scope).length === 0 || !canLoadGitScopeTargets(provider)
          ? []
          : [
              ...(resources?.[scope] ?? []),
              ...(inheritedParsed.resources[scope] ?? []),
              ...(allowedResourceIds?.[scope] ?? []),
            ].flatMap((qualifier) =>
              parseGitQualifier(qualifier)?.kind ? [gitLabelKey(provider, qualifier)] : []
            )
      )
    ),
  ]
    .filter((key) => !(key in gitLabels) && !gitLabelFailures.has(key))
    .sort();
  const pendingGitLabelsKey = pendingGitLabelKeys.join("\n");
  const rememberGitLabels = useCallback((labels: Record<string, GitTargetLabel>) => {
    setGitLabels((current) => ({ ...current, ...labels }));
  }, []);

  // A label lookup still pending holds the first reveal, like the option lists do.
  const initialLoading =
    !(
      catalogReady &&
      foldersReady &&
      dockerReady &&
      registriesReady &&
      gitConnectorsReady &&
      appsReady
    ) || pendingGitLabelKeys.length > 0;
  useContentLoading(initialLoading);
  const initialLoadReported = useRef(false);
  useEffect(() => {
    if (initialLoading || initialLoadReported.current) return;
    initialLoadReported.current = true;
    onInitialLoadComplete?.();
  }, [initialLoading, onInitialLoadComplete]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The lookup permission helper reads the actor's current scopes from the store.
  useEffect(() => {
    const providers = gitProvidersKey
      .split(",")
      .filter((provider): provider is GitScopeProvider => provider.length > 0);
    if (providers.length === 0) {
      setGitConnectors({});
      setGitConnectorsReady(true);
      return;
    }
    let cancelled = false;
    void loadGitScopeConnectors(providers)
      .then((catalog) => {
        if (!cancelled) setGitConnectors(catalog);
      })
      .finally(() => {
        if (!cancelled) setGitConnectorsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [gitProvidersKey, actorScopes]);

  useEffect(() => {
    const keys = pendingGitLabelsKey
      .split("\n")
      .filter((key) => key.length > 0 && !gitLabelsInFlight.current.has(key));
    if (keys.length === 0) return;
    const byProvider = new Map<GitScopeProvider, string[]>();
    for (const key of keys) {
      gitLabelsInFlight.current.add(key);
      const separator = key.indexOf(":");
      const provider = key.slice(0, separator) as GitScopeProvider;
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), key.slice(separator + 1)]);
    }
    // Results are kept even if the list changed meanwhile: labels do not depend on the row.
    for (const [provider, qualifiers] of byProvider) {
      const providerKeys = qualifiers.map((qualifier) => gitLabelKey(provider, qualifier));
      void resolveGitTargetLabels(provider, qualifiers)
        .then(({ labels, errors }) => {
          rememberGitLabels(labels);
          // Anything left unanswered counts as failed, so the first reveal never waits forever.
          const unresolved = providerKeys.filter((key) => !(key in labels));
          if (unresolved.length > 0) {
            setGitLabelFailures((current) => new Set([...current, ...unresolved]));
          }
          for (const error of errors) {
            reportScopeLoadError(`${GIT_PROVIDER_LABELS[provider]} permission targets`, error);
          }
        })
        .finally(() => {
          for (const key of providerKeys) gitLabelsInFlight.current.delete(key);
        });
    }
  }, [pendingGitLabelsKey, rememberGitLabels]);

  // "Apply to the other Git scopes in this section": a restricted Git row hands its own
  // connector, group and project qualifiers to the other selected Git scopes of its provider
  // and section, so use, view and repo:read get the same limit in one step.
  const gitRestrictionCopy = (scope: ScopeItem) => {
    if (!onResourcesChange || readOnly) return null;
    const plan = planGitRestrictionCopy({
      scope,
      scopes,
      selected,
      resources,
      restrictableScopes,
      allowedResourceIds,
      inheritedResources: inheritedParsed.resources,
      labels: gitLabels,
    });
    if (!plan) return null;
    return {
      targetLabels: plan.targetLabels,
      apply: () => {
        onResourcesChange({ ...(resources ?? {}), ...plan.changes });
        toast.success(`Applied to ${plan.targetLabels.join(", ")}`);
      },
    };
  };

  const isSelected = (scope: ScopeItem) =>
    selected.includes(scope.value) || inheritedBaseSet.has(scope.value);
  const selectionFilteredScopes = scopes.filter((scope) => {
    if (selectionFilter === "selected") return isSelected(scope);
    if (selectionFilter === "unselected") return !isSelected(scope);
    return true;
  });
  const directMatches = q ? selectionFilteredScopes.filter((scope) => matchesQuery(scope, q)) : [];
  const visibleScopes = q
    ? directMatches.length > 0
      ? directMatches
      : selectionFilteredScopes.filter((scope) => scope.group.toLowerCase().includes(q))
    : selectionFilteredScopes;
  const categories = [...new Set(visibleScopes.map((s) => s.group))];
  const folderFamiliesKey = [
    ...new Set(
      scopes
        .filter((scope) => selected.includes(scope.value) || inheritedBaseSet.has(scope.value))
        .map((scope) => folderFamilyForScope(scope.value))
        .filter(Boolean)
    ),
  ]
    .sort()
    .join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: Folder lookup helpers read current auth/features from stores.
  useEffect(() => {
    const families = folderFamiliesKey
      .split(",")
      .filter((family): family is FolderFamily => family.length > 0);
    if (families.length === 0) {
      setFolderOptions([]);
      onFolderOptionsChange?.([]);
      setFoldersReady(true);
      return;
    }
    let cancelled = false;
    const loads: Promise<unknown>[] = [
      Promise.all(families.map(loadFolderFamily)).then((options) => {
        if (cancelled) return;
        setFolderOptions(options.flat());
        onFolderOptionsChange?.(options.flat());
      }),
    ];
    if (families.includes("domains") && canLoadScopeResource("domains:view")) {
      loads.push(
        allResourcePages((page) => api.listDomains({ page, limit: 100 }))
          .then((response) => {
            if (!cancelled) setDomainResources(response);
          })
          .catch((error) => {
            if (!cancelled) {
              setDomainResources([]);
              reportScopeLoadError("domains", error);
            }
          })
      );
    } else {
      setDomainResources([]);
    }
    if (
      families.includes("logging-environments") &&
      canLoadScopeResource("logs:environments:view")
    ) {
      loads.push(
        api
          .listLoggingEnvironments()
          .then((items) => {
            if (!cancelled) setLoggingEnvironments(items ?? []);
          })
          .catch((error) => {
            if (!cancelled) {
              setLoggingEnvironments([]);
              reportScopeLoadError("logging environments", error);
            }
          })
      );
    } else {
      setLoggingEnvironments([]);
    }
    void Promise.allSettled(loads).then(() => {
      if (!cancelled) setFoldersReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [folderFamiliesKey, actorScopes, features]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The lookup permission helper reads the actor's current scopes from the store.
  useEffect(() => {
    const dockerNodes = (nodes ?? []).filter(
      (node) => node.type === "docker" && canLoadScopeResource("docker:containers:view", node.id)
    );
    const needsDockerResources = scopes.some(
      (scope) =>
        ((scope.value.startsWith("docker:containers:") &&
          scope.value !== "docker:containers:create") ||
          scope.value === "docker:availability:manage") &&
        restrictableScopes?.includes(scope.value)
    );
    if (!needsDockerResources || dockerNodes.length === 0) {
      setDockerResources([]);
      setDockerReady(true);
      return;
    }

    let cancelled = false;
    void Promise.all(
      dockerNodes.map(async (node) => {
        const containers = await api.listDockerContainers(node.id).catch((error) => {
          if (!cancelled)
            reportScopeLoadError(`containers on ${node.displayName || node.hostname}`, error);
          return [];
        });
        return containers.flatMap((resource) =>
          resource.scopeResourceId
            ? [
                {
                  id: resource.scopeResourceId,
                  nodeId: node.id,
                  label: resource.name,
                  folderId: resource.folderId,
                  kind:
                    resource.kind === "deployment"
                      ? ("deployment" as const)
                      : ("container" as const),
                },
              ]
            : []
        );
      })
    )
      .then((resourcesByNode) => {
        if (!cancelled) setDockerResources(resourcesByNode.flat());
      })
      .finally(() => {
        if (!cancelled) setDockerReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nodes, restrictableScopes, scopes, actorScopes]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The lookup permission helper reads the actor's current scopes from the store.
  useEffect(() => {
    const needsRepositories = scopes.some(
      (scope) =>
        scope.value.startsWith("docker:registries:internal:") &&
        restrictableScopes?.includes(scope.value)
    );
    if (!needsRepositories || !canLoadScopeResource("docker:registries:view")) {
      setDockerRegistryRepositories([]);
      setRegistriesReady(true);
      return;
    }
    let cancelled = false;
    void api
      .listDockerInternalRegistryRepositories()
      .then((repositories) => {
        if (!cancelled) setDockerRegistryRepositories(repositories);
      })
      .catch((error) => {
        if (!cancelled) {
          setDockerRegistryRepositories([]);
          reportScopeLoadError("registry repositories", error);
        }
      })
      .finally(() => {
        if (!cancelled) setRegistriesReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [restrictableScopes, scopes, actorScopes]);

  return (
    <div className={cn("max-sm:max-h-[40vh] max-sm:overflow-y-auto", viewportClassName)}>
      {categories.map((cat) => {
        const catScopes = visibleScopes.filter((s) => s.group === cat);
        if (catScopes.length === 0) return null;
        return (
          <div key={cat}>
            {cat && (
              <div className="px-3 py-1.5 bg-muted sticky top-0 z-10 border-b border-border">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {cat}
                </p>
              </div>
            )}
            {catScopes.map((scope) => (
              <ScopeRow
                key={scope.value}
                scope={scope}
                isSelected={selected.includes(scope.value) || inheritedBaseSet.has(scope.value)}
                isOwnSelected={selected.includes(scope.value)}
                onToggle={onToggle}
                muted={false}
                disabled={readOnly}
                resources={resources}
                inheritedResources={inheritedParsed.resources}
                inheritedExactBase={inheritedParsed.exactBaseScopes.has(scope.value)}
                onToggleResource={onToggleResource}
                cas={cas}
                nodes={nodes}
                proxyHosts={proxyHosts}
                databases={databases}
                domains={domainResources}
                loggingEnvironments={loggingEnvironments}
                loggingSchemas={loggingSchemas}
                dockerResources={dockerResources}
                dockerRegistryRepositories={dockerRegistryRepositories}
                resourceCatalog={rowCatalog}
                folderOptions={rowFolderOptions}
                restrictableScopes={restrictableScopes}
                allowedResourceIds={allowedResourceIds}
                inheritedFromName={inheritedFromName}
                collapsible={collapsedRestrictions}
                expanded={expandedScopes.has(scope.value)}
                onToggleExpanded={() => toggleExpanded(scope.value)}
                gitConnectors={gitConnectors}
                gitLabels={gitLabels}
                onRememberGitLabels={rememberGitLabels}
                gitRestrictionCopy={gitRestrictionCopy(scope)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ScopeRow({
  scope,
  isSelected,
  isOwnSelected,
  onToggle,
  muted,
  disabled,
  resources,
  inheritedResources,
  inheritedExactBase,
  onToggleResource,
  cas,
  nodes,
  proxyHosts,
  databases,
  domains,
  loggingEnvironments,
  loggingSchemas,
  dockerResources,
  dockerRegistryRepositories,
  resourceCatalog,
  folderOptions,
  restrictableScopes,
  allowedResourceIds,
  inheritedFromName,
  collapsible = false,
  expanded = false,
  onToggleExpanded,
  gitConnectors,
  gitLabels,
  onRememberGitLabels,
  gitRestrictionCopy,
}: {
  scope: ScopeItem;
  isSelected: boolean;
  isOwnSelected: boolean;
  onToggle: (scope: string) => void;
  muted: boolean;
  disabled?: boolean;
  resources?: Record<string, string[]>;
  inheritedResources?: Record<string, string[]>;
  inheritedExactBase?: boolean;
  onToggleResource?: (scope: string, resourceId: string) => void;
  cas?: CA[];
  nodes?: Node[];
  proxyHosts?: ProxyHost[];
  databases?: DatabaseConnection[];
  domains?: Domain[];
  loggingEnvironments?: LoggingEnvironment[];
  loggingSchemas?: LoggingSchema[];
  dockerResources?: DockerResourceOption[];
  dockerRegistryRepositories?: string[];
  resourceCatalog?: ScopeResourceCatalog;
  folderOptions?: FolderOption[];
  restrictableScopes?: readonly string[];
  allowedResourceIds?: Record<string, string[]>;
  inheritedFromName?: string;
  collapsible?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  gitConnectors: GitScopeConnectorCatalog;
  gitLabels: GitTargetLabels;
  onRememberGitLabels: (labels: Record<string, GitTargetLabel>) => void;
  /** Copies this Git row's restriction to the other Git scopes of its section. */
  gitRestrictionCopy?: { targetLabels: string[]; apply: () => void } | null;
}) {
  const isRestrictable = restrictableScopes?.includes(scope.value) ?? false;
  const gitProvider = isRestrictable ? gitScopeProvider(scope.value) : null;
  const selectedIds = resources?.[scope.value] || [];
  const inheritedSelectedIds = inheritedResources?.[scope.value] || [];
  const inheritedSet = new Set(inheritedSelectedIds);
  const combinedSelectedIds = [...new Set([...inheritedSelectedIds, ...selectedIds])];
  const selectedResourceIds = combinedSelectedIds.filter((id) => !isFolderTarget(id));
  const family = folderFamilyForScope(scope.value);
  const baseResourceOptions = isRestrictable
    ? getResourceOptions(
        scope.value,
        cas,
        nodes,
        proxyHosts,
        databases,
        domains,
        loggingEnvironments,
        loggingSchemas,
        dockerResources,
        dockerRegistryRepositories,
        resourceCatalog
      )
    : [];
  const allowedIds = allowedResourceIds?.[scope.value];
  const resourceOptions = allowedIds
    ? baseResourceOptions.filter(
        (opt) =>
          allowedIds.includes(opt.id) ||
          (!!opt.parentId && allowedIds.includes(opt.parentId)) ||
          (!opt.parentId &&
            baseResourceOptions.some(
              (child) => child.parentId === opt.id && allowedIds.includes(child.id)
            ))
      )
    : [...baseResourceOptions];
  for (const allowedId of allowedIds ?? []) {
    if (!resourceOptions.some((opt) => opt.id === allowedId)) {
      resourceOptions.push({ id: allowedId, label: allowedId });
    }
  }
  for (const selectedId of selectedResourceIds) {
    if (!resourceOptions.some((opt) => opt.id === selectedId)) {
      resourceOptions.push({ id: selectedId, label: selectedId });
    }
  }
  // Hidden app folders show only where a grant names them: they are never offered.
  const availableFolderOptions = (folderOptions ?? []).filter(
    (folder) =>
      folder.family === family &&
      (!folder.appEnvironment ||
        combinedSelectedIds.includes(folderTarget(folder.id)) ||
        !!allowedResourceIds?.[scope.value]?.includes(folderTarget(folder.id)))
  );
  const visibleFolderOptions = allowedIds
    ? availableFolderOptions.filter((folder) => allowedIds.includes(folderTarget(folder.id)))
    : availableFolderOptions;
  const restrictionRows: RestrictionRow[] = [];
  if (family === "docker" || family?.startsWith("docker-")) {
    const nodeOptions = resourceOptions.filter((option) => !option.parentId);
    const childOptions = resourceOptions.filter((option) => !!option.parentId);
    const renderedFolderIds = new Set<string>();
    for (const node of nodeOptions) {
      restrictionRows.push({ type: "resource", key: node.id, resource: node, depth: 0 });
      const nodeChildren = childOptions.filter((option) => option.parentId === node.id);
      for (const folder of visibleFolderOptions) {
        const folderChildren = nodeChildren.filter((option) => option.folderId === folder.id);
        const hasNestedChildren = nodeChildren.some((option) => {
          const resourceFolder = option.folderId
            ? availableFolderOptions.find((candidate) => candidate.id === option.folderId)
            : undefined;
          return resourceFolder?.ancestorIds.includes(folder.id);
        });
        if (folderChildren.length === 0 && !hasNestedChildren) continue;
        restrictionRows.push({
          type: "folder",
          key: `${node.id}:${folder.id}`,
          folder,
          depth: 1,
        });
        renderedFolderIds.add(folder.id);
        for (const resource of folderChildren) {
          restrictionRows.push({
            type: "resource",
            key: resource.id,
            resource,
            depth: 2,
          });
        }
      }
      for (const resource of nodeChildren.filter((option) => !option.folderId)) {
        restrictionRows.push({
          type: "resource",
          key: resource.id,
          resource,
          depth: 1,
        });
      }
    }
    for (const folder of visibleFolderOptions.filter(
      (option) => !renderedFolderIds.has(option.id)
    )) {
      restrictionRows.push({ type: "folder", key: folder.id, folder, depth: 0 });
    }
  } else {
    for (const folder of visibleFolderOptions) {
      restrictionRows.push({ type: "folder", key: folder.id, folder, depth: 0 });
      for (const resource of resourceOptions.filter((option) => option.folderId === folder.id)) {
        restrictionRows.push({
          type: "resource",
          key: resource.id,
          resource,
          depth: 1,
        });
      }
    }
    for (const resource of resourceOptions.filter((option) => !option.folderId)) {
      restrictionRows.push({ type: "resource", key: resource.id, resource, depth: 0 });
    }
  }
  // Git scopes render their own connector and target rows.
  const listedRestrictionRows = gitProvider ? [] : restrictionRows;
  // Nodes and folders that hold rows below them fold, so a long container list stays short; a
  // lone top-level group starts open. `toggledGroups` holds the groups flipped from that default.
  const [toggledGroups, setToggledGroups] = useState<ReadonlySet<string>>(() => new Set());
  const groupKeys = new Set(
    listedRestrictionRows
      .filter((row, index) => (listedRestrictionRows[index + 1]?.depth ?? -1) > row.depth)
      .map((row) => row.key)
  );
  const topGroups = listedRestrictionRows.filter(
    (row) => row.depth === 0 && groupKeys.has(row.key)
  );
  const isGroupOpen = (key: string) =>
    toggledGroups.has(key) !== (topGroups.length === 1 && topGroups[0]?.key === key);
  const toggleGroup = (key: string) =>
    setToggledGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const isRowChecked = (row: RestrictionRow) =>
    combinedSelectedIds.includes(
      row.type === "folder" ? folderTarget(row.folder.id) : row.resource.id
    );
  const visibleRestrictionRows: { row: RestrictionRow; hiddenSelected: number }[] = [];
  {
    const ancestors: { depth: number; open: boolean }[] = [];
    listedRestrictionRows.forEach((row, index) => {
      while (ancestors.length > 0 && (ancestors.at(-1)?.depth ?? -1) >= row.depth) ancestors.pop();
      const isGroup = groupKeys.has(row.key);
      const open = isGroup && isGroupOpen(row.key);
      if (ancestors.every((ancestor) => ancestor.open)) {
        let hiddenSelected = 0;
        if (isGroup && !open) {
          for (const below of listedRestrictionRows.slice(index + 1)) {
            if (below.depth <= row.depth) break;
            if (isRowChecked(below)) hiddenSelected += 1;
          }
        }
        visibleRestrictionRows.push({ row, hiddenSelected });
      }
      if (isGroup) ancestors.push({ depth: row.depth, open });
    });
  }
  const treeHasGroups = groupKeys.size > 0;
  const groupToggle = (row: RestrictionRow, label: string, hiddenSelected: number) => {
    if (!treeHasGroups) return null;
    if (!groupKeys.has(row.key)) return <span className="w-4 shrink-0" aria-hidden="true" />;
    const open = isGroupOpen(row.key);
    return (
      <button
        type="button"
        onClick={() => toggleGroup(row.key)}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${label}${
          hiddenSelected > 0 ? `, ${hiddenSelected} selected` : ""
        }`}
        className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
      </button>
    );
  };
  const hasRestrictionOptions = gitProvider
    ? (gitConnectors[gitProvider]?.length ?? 0) > 0 ||
      combinedSelectedIds.length > 0 ||
      (allowedIds?.length ?? 0) > 0
    : resourceOptions.length > 0 || visibleFolderOptions.length > 0;
  const showRestrictions =
    isRestrictable &&
    hasRestrictionOptions &&
    (isSelected || combinedSelectedIds.length > 0) &&
    (!disabled || combinedSelectedIds.length > 0);
  const collapsed = collapsible && !expanded;
  const restrictionLabel = (id: string) => {
    if (gitProvider)
      return gitQualifierLabel(gitProvider, id, gitConnectors[gitProvider], gitLabels);
    if (isFolderTarget(id)) {
      const folder = availableFolderOptions.find((option) => folderTarget(option.id) === id);
      if (folder?.appEnvironment) return folder.label;
      return `${folder?.label ?? id.slice("folder/".length)} (folder)`;
    }
    return resourceOptions.find((option) => option.id === id)?.label ?? id;
  };
  // Without a broad grant the scope must name resources; "All resources" is not an option then.
  const restrictionSummary =
    combinedSelectedIds.length === 0
      ? allowedIds
        ? gitProvider
          ? "No connectors selected"
          : "No resources selected"
        : gitProvider
          ? "All connectors"
          : "All resources"
      : [
          ...combinedSelectedIds.slice(0, 3).map(restrictionLabel),
          ...(combinedSelectedIds.length > 3 ? [`+${combinedSelectedIds.length - 3} more`] : []),
        ].join(", ");
  const baseLocked = (!!inheritedExactBase || inheritedSelectedIds.length > 0) && !isOwnSelected;
  const rowDisabled = disabled || baseLocked;
  const showTechnicalValue = !scope.hideValue && scope.value !== scope.label;
  const copyTargets = gitRestrictionCopy?.targetLabels.join(", ");
  const showDescription = scope.desc !== scope.label && scope.desc !== scope.value;

  return (
    <div className={cn(muted && "opacity-40")}>
      <label
        className={cn(
          "flex items-center gap-3 px-3 py-2",
          rowDisabled ? "cursor-default" : "cursor-pointer transition-colors hover:bg-accent",
          disabled && "opacity-60"
        )}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => !rowDisabled && onToggle(scope.value)}
          disabled={rowDisabled}
          className="form-checkbox"
        />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-sm">{scope.label}</p>
            {showTechnicalValue && (
              <p className="text-xs text-muted-foreground font-mono">{scope.value}</p>
            )}
            {baseLocked && inheritedFromName && (
              <p className="text-xs text-muted-foreground">inherited from {inheritedFromName}</p>
            )}
          </div>
          {showDescription && <p className="text-xs text-muted-foreground">{scope.desc}</p>}
        </div>
        {scope.meta && <span className="text-xs text-muted-foreground">{scope.meta}</span>}
      </label>
      {showRestrictions && collapsed && (
        <div className="flex flex-wrap items-center gap-x-1.5 px-3 pb-2 pl-10 text-xs text-muted-foreground">
          <span>{restrictionSummary}</span>
          <span aria-hidden="true">·</span>
          <Button
            type="button"
            variant="quiet"
            size="inline"
            onClick={onToggleExpanded}
            aria-label={disabled ? `Show ${scope.label} restrictions` : `Restrict ${scope.label}`}
          >
            {disabled ? "Show" : combinedSelectedIds.length === 0 ? "Restrict…" : "Change…"}
          </Button>
        </div>
      )}
      {showRestrictions && !collapsed && (
        <div className="px-3 pb-2 pl-10">
          <div className="mb-1 flex items-start justify-between gap-2 text-xs">
            <p className="text-muted-foreground">{getResourceLabel(scope.value)}</p>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3">
              {gitRestrictionCopy && !disabled && (
                <Button
                  type="button"
                  variant="quiet"
                  size="inline"
                  onClick={gitRestrictionCopy.apply}
                  title={`Same restriction for ${copyTargets}`}
                  aria-label={`Apply the ${scope.label} restriction to ${copyTargets}`}
                >
                  Apply to the other Git scopes in this section
                </Button>
              )}
              {collapsible && (
                <Button
                  type="button"
                  variant="quiet"
                  size="inline"
                  onClick={onToggleExpanded}
                  aria-label={
                    disabled
                      ? `Hide ${scope.label} restrictions`
                      : `Done restricting ${scope.label}`
                  }
                >
                  {disabled ? "Hide" : "Done"}
                </Button>
              )}
            </div>
          </div>
          {gitProvider && (
            <GitScopeRestriction
              scopeLabel={scope.label}
              provider={gitProvider}
              targetKinds={gitScopeTargetKinds(scope.value)}
              connectors={gitConnectors[gitProvider]}
              labels={gitLabels}
              selectedIds={selectedIds}
              inheritedIds={inheritedSelectedIds}
              allowedIds={allowedIds}
              disabled={disabled}
              showInherited={!!inheritedFromName}
              onToggle={
                onToggleResource
                  ? (qualifier) => onToggleResource(scope.value, qualifier)
                  : undefined
              }
              onRememberLabels={onRememberGitLabels}
            />
          )}
          {visibleRestrictionRows.map(({ row, hiddenSelected }) => {
            const selectedBelow = hiddenSelected > 0 && (
              <span className="text-xs text-muted-foreground">{hiddenSelected} selected</span>
            );
            if (row.type === "resource") {
              const opt = row.resource;
              const parentSelected = !!opt.parentId && combinedSelectedIds.includes(opt.parentId);
              const parentInherited = !!opt.parentId && inheritedSet.has(opt.parentId);
              const resourceFolder = opt.folderId
                ? availableFolderOptions.find((folder) => folder.id === opt.folderId)
                : undefined;
              const folderTargets = resourceFolder
                ? [resourceFolder.id, ...resourceFolder.ancestorIds].map(folderTarget)
                : [];
              const folderSelected = folderTargets.some((target) =>
                combinedSelectedIds.includes(target)
              );
              const folderInherited = folderTargets.some((target) => inheritedSet.has(target));
              const contextOnly = !!allowedIds && !allowedIds.includes(opt.id);
              const optionDisabled = !!disabled || parentSelected || folderSelected || contextOnly;
              return (
                <div
                  key={row.key}
                  className={cn(
                    "flex items-center gap-1",
                    row.depth === 1 && "pl-5",
                    row.depth === 2 && "pl-10"
                  )}
                >
                  {groupToggle(row, opt.label, hiddenSelected)}
                  <label
                    className={cn(
                      "flex min-w-0 items-center gap-2 py-0.5 text-xs",
                      optionDisabled ? "cursor-default opacity-60" : "cursor-pointer"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={
                        parentSelected || folderSelected || combinedSelectedIds.includes(opt.id)
                      }
                      onChange={() =>
                        !optionDisabled &&
                        !inheritedSet.has(opt.id) &&
                        onToggleResource?.(scope.value, opt.id)
                      }
                      disabled={optionDisabled || inheritedSet.has(opt.id) || !onToggleResource}
                      className="form-checkbox"
                    />
                    <span>{opt.label}</span>
                    {opt.kind && <span className="text-xs text-muted-foreground">{opt.kind}</span>}
                    {(inheritedSet.has(opt.id) || parentInherited || folderInherited) &&
                      inheritedFromName && (
                        <span className="text-xs text-muted-foreground">inherited</span>
                      )}
                  </label>
                  {selectedBelow}
                </div>
              );
            }

            const folder = row.folder;
            const target = folderTarget(folder.id);
            const inherited = inheritedSet.has(target);
            const parentSelected = folder.ancestorIds.some((id) =>
              combinedSelectedIds.includes(folderTarget(id))
            );
            return (
              <div
                key={row.key}
                className={cn("flex items-center gap-1", row.depth === 1 && "pl-5")}
              >
                {groupToggle(row, folder.label, hiddenSelected)}
                <label
                  className={cn(
                    "flex min-w-0 items-center gap-2 py-0.5 text-xs",
                    disabled || parentSelected ? "cursor-default opacity-60" : "cursor-pointer"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={parentSelected || combinedSelectedIds.includes(target)}
                    onChange={() =>
                      !disabled &&
                      !parentSelected &&
                      !inherited &&
                      onToggleResource?.(scope.value, target)
                    }
                    disabled={disabled || parentSelected || inherited || !onToggleResource}
                    className="form-checkbox"
                  />
                  <span>{folder.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {folder.appEnvironment ? "app environment" : "folder"}
                  </span>
                  {inherited && inheritedFromName && (
                    <span className="text-xs text-muted-foreground">inherited</span>
                  )}
                </label>
                {selectedBelow}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
