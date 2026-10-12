import { useEffect, useState } from "react";
import type { ComboboxOption } from "@/components/common/Combobox";
import { gitScopeTruncationHint } from "@/components/common/git-scope-targets";
import { useDialogPresence } from "@/components/ui/dialog";
import { pickerLoadError } from "@/lib/picker-load-error";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { DockerBuildSourceRepository, DockerSourceTarget } from "@/types";
import type { GitScopeTargetTruncation } from "@/types/integrations";

const SEARCH_DEBOUNCE_MS = 300;
/** How long a loaded repository list is reused when a picker opens again. */
const REPOSITORY_LIST_TTL_MS = 60_000;
/** Integrations whose repositories load as soon as the integration list arrives. */
const REPOSITORY_PREFETCH_LIMIT = 5;

interface RepositoryList {
  repositories: DockerBuildSourceRepository[];
  truncated?: GitScopeTargetTruncation;
  /** The server answered with its last list while it reloads it. */
  refreshing?: boolean;
}

/** Repository lists by integration and picker endpoint, shared by every picker for a minute. */
const repositoryLists = new Map<
  string,
  { request: Promise<RepositoryList>; list?: RepositoryList; loadedAt: number }
>();

function repositoryListKey(connectorId: string, target?: DockerSourceTarget): string {
  // The list depends on the caller's grants; Pages Projects list through their own endpoint (and
  // permission), every Docker target shares one.
  const userId = useAuthStore.getState().user?.id ?? "";
  const endpoint = target?.kind === "pages_project" ? `pages:${target.pageProjectId}` : "docker";
  return `${userId}:${connectorId}:${endpoint}`;
}

function freshRepositoryListEntry(key: string) {
  const entry = repositoryLists.get(key);
  return entry && Date.now() - entry.loadedAt < REPOSITORY_LIST_TTL_MS ? entry : undefined;
}

function storeRepositoryList(key: string, list: RepositoryList) {
  repositoryLists.set(key, { request: Promise.resolve(list), list, loadedAt: Date.now() });
}

/** The integration's repository list: a recent one, the one already loading, or a new request. */
function loadRepositoryList(connectorId: string, target?: DockerSourceTarget) {
  const key = repositoryListKey(connectorId, target);
  const cached = freshRepositoryListEntry(key);
  if (cached) return cached.request;
  const request = api.listDockerBuildRepositories(connectorId, target);
  const entry: { request: Promise<RepositoryList>; list?: RepositoryList; loadedAt: number } = {
    request,
    loadedAt: Date.now(),
  };
  repositoryLists.set(key, entry);
  request.then(
    (list) => {
      entry.list = list;
    },
    () => {
      // A failed list is not reused: the next picker asks again.
      if (repositoryLists.get(key) === entry) repositoryLists.delete(key);
    }
  );
  return request;
}

/** Why the integration or repository picker is empty, when its list could not be loaded. */
export interface SourcePickerErrors {
  connectors: string | null;
  repositories: string | null;
}

export function useDockerSourceRepositories(
  open: boolean,
  connectorId: string,
  target?: DockerSourceTarget
) {
  const [connectorOptions, setConnectorOptions] = useState<ComboboxOption[]>([]);
  const [connectorsLoaded, setConnectorsLoaded] = useState(false);
  const [repositories, setRepositories] = useState<DockerBuildSourceRepository[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);
  const [listTruncation, setListTruncation] = useState<GitScopeTargetTruncation>();
  const [search, setSearch] = useState("");
  const [searchTruncation, setSearchTruncation] = useState<GitScopeTargetTruncation>();
  // Loaded lists stay while the dialog closes; they are dropped once it is gone.
  const present = useDialogPresence(open);

  useEffect(() => {
    if (!present) {
      setConnectorsLoaded(false);
      return;
    }
    let cancelled = false;
    // One picker list authorized by the workload's create/edit scope, so a missing integration scope for one
    // provider can no longer blank the whole list.
    void api
      .listDockerSourceConnectors()
      .then((connectors) => {
        if (cancelled) return;
        // Load the repositories while the user picks an integration, so the picker opens filled.
        for (const connector of connectors.slice(0, REPOSITORY_PREFETCH_LIMIT)) {
          loadRepositoryList(connector.id, target).catch(() => undefined);
        }
        setConnectorsError(null);
        setConnectorOptions(
          connectors.map((connector) => ({
            value: connector.id,
            label: connector.name,
            keywords: connector.provider,
          }))
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setConnectorOptions([]);
        setConnectorsError(pickerLoadError(error, "Git integrations"));
      })
      .finally(() => {
        if (!cancelled) setConnectorsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [present, target]);

  useEffect(() => {
    setListTruncation(undefined);
    setSearch("");
    setRepositoriesError(null);
    if (!present || !connectorId) {
      setRepositories([]);
      setRepositoriesLoading(false);
      return;
    }
    let cancelled = false;
    const key = repositoryListKey(connectorId, target);
    const show = (list: RepositoryList) => {
      setListTruncation(list.truncated);
      setRepositories(list.repositories.filter((repository) => !repository.archived));
    };
    // The server answered with its last list while it reloads it: the reloaded list replaces it.
    const followRefresh = (list: RepositoryList) => {
      if (!list.refreshing) return;
      void api
        .listDockerBuildRepositories(connectorId, target, undefined, { awaitRefresh: true })
        .then((reloaded) => {
          storeRepositoryList(key, reloaded);
          if (!cancelled) show(reloaded);
        })
        .catch(() => {
          // The shown list stays; the next picker asks again.
        });
    };
    const cached = freshRepositoryListEntry(key)?.list;
    if (cached) {
      show(cached);
      setRepositoriesLoading(false);
      followRefresh(cached);
    } else {
      // Never offer the previous integration's repositories while this one loads.
      setRepositories([]);
      setRepositoriesLoading(true);
      loadRepositoryList(connectorId, target)
        .then((list) => {
          if (cancelled) return;
          show(list);
          setRepositoriesLoading(false);
          followRefresh(list);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setRepositories([]);
          setRepositoriesLoading(false);
          setRepositoriesError(pickerLoadError(error, "repositories"));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [connectorId, present, target]);

  // A cut list (a GitHub account past the listing bound) is searched on the server as the user
  // types; found repositories join the list, so a picked one stays selectable.
  const query = search.trim();
  useEffect(() => {
    if (!present || !connectorId || !listTruncation || !query) {
      setSearchTruncation(undefined);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .listDockerBuildRepositories(connectorId, target, query)
        .then(({ repositories: found, truncated }) => {
          if (cancelled) return;
          setSearchTruncation(truncated);
          setRepositories((current) => {
            const known = new Set(current.map((repository) => repository.projectId));
            const added = found.filter(
              (repository) => !repository.archived && !known.has(repository.projectId)
            );
            return added.length > 0 ? [...current, ...added] : current;
          });
        })
        .catch(() => {
          // The list stays as it was; the hint keeps asking for a narrower search.
          if (!cancelled) setSearchTruncation({ more: 0, exact: false });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connectorId, listTruncation, present, query, target]);

  const loadErrors: SourcePickerErrors = {
    connectors: connectorsError,
    repositories: repositoriesError,
  };
  // The integration picker a repository form opens with; repositories follow the user's choice.
  return {
    connectorOptions,
    connectorsLoading: present && !connectorsLoaded,
    repositories,
    /** The selected integration's repositories are loading (no list to show yet). */
    repositoriesLoading: present && !!connectorId && repositoriesLoading,
    loadErrors,
    /** "More may exist, refine the search." while the list or the current search is cut. */
    repositoriesHint: gitScopeTruncationHint(query ? searchTruncation : listTruncation),
    onRepositorySearch: setSearch,
  };
}
