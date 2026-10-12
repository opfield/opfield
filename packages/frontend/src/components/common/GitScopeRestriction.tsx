import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { Button } from "@/components/ui/button";
import { useDialogPresence } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SelectItemCheck, selectItemClassName } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { GitScopeTargetTruncation } from "@/types/integrations";
import {
  GIT_PROVIDER_TARGET_KINDS,
  GIT_PROVIDER_TARGET_NOUNS,
  GIT_TARGET_KIND_LABELS,
  type GitScopeConnector,
  type GitScopeProvider,
  type GitScopeTargetOption,
  type GitTargetKind,
  type GitTargetLabel,
  type GitTargetLabels,
  gitLabelKey,
  gitQualifier,
  gitQualifierLabel,
  gitScopeTruncationHint,
  gitTargetCovered,
  parseGitQualifier,
  searchGitScopeTargets,
} from "./git-scope-targets";

const SEARCH_DEBOUNCE_MS = 300;

const SECTION_LABELS: Record<GitTargetKind, string> = {
  group: "Groups",
  project: "Projects",
  owner: "Owners",
  repo: "Repositories",
};

interface GitScopeRestrictionProps {
  scopeLabel: string;
  provider: GitScopeProvider;
  /** Kinds this scope takes within a connector; none for generic Git and connector administration. */
  targetKinds: readonly GitTargetKind[];
  /** Connectors of the provider; undefined when they could not be listed. */
  connectors: readonly GitScopeConnector[] | undefined;
  labels: GitTargetLabels;
  /** The row's own qualifiers. */
  selectedIds: readonly string[];
  /** Qualifiers inherited from a parent group; shown selected and locked. */
  inheritedIds: readonly string[];
  /** Qualifiers the granting user holds; undefined when the grant is unrestricted. */
  allowedIds?: readonly string[];
  disabled?: boolean;
  showInherited?: boolean;
  onToggle?: (qualifier: string) => void;
  /** Keeps labels of targets picked in the picker, so they need no lookup. */
  onRememberLabels: (labels: Record<string, GitTargetLabel>) => void;
}

/**
 * Restriction editor for a Git integration scope: connectors, and within a GitLab or GitHub
 * connector its groups and projects or owners and repositories, bounded by `allowedIds`.
 */
export function GitScopeRestriction({
  scopeLabel,
  provider,
  targetKinds,
  connectors,
  labels,
  selectedIds,
  inheritedIds,
  allowedIds,
  disabled,
  showInherited,
  onToggle,
  onRememberLabels,
}: GitScopeRestrictionProps) {
  // Targets unchecked here stay listed, so a mis-click can be undone in place.
  const [seenIds, setSeenIds] = useState<readonly string[]>([]);
  const inheritedSet = new Set(inheritedIds);
  const combinedIds = [...new Set([...inheritedIds, ...selectedIds])];
  const pathOf = (qualifier: string) => {
    const entry = labels[gitLabelKey(provider, qualifier)];
    return entry && !entry.missing ? entry.label : null;
  };
  const labelOf = (qualifier: string) => gitQualifierLabel(provider, qualifier, connectors, labels);
  const toggle = (qualifier: string) => {
    if (!onToggle) return;
    setSeenIds((current) => (current.includes(qualifier) ? current : [...current, qualifier]));
    onToggle(qualifier);
  };

  const connectorIds = [
    ...new Set([
      ...(connectors ?? []).map((connector) => connector.id),
      ...[...combinedIds, ...(allowedIds ?? [])].flatMap(
        (qualifier) => parseGitQualifier(qualifier)?.connectorId ?? []
      ),
    ]),
  ];

  return (
    <>
      {connectorIds.map((connectorId) => {
        const connector = connectors?.find((candidate) => candidate.id === connectorId);
        const connectorAllowed = !allowedIds || allowedIds.includes(connectorId);
        const inConnector = (qualifier: string) => {
          const parsed = parseGitQualifier(qualifier);
          return parsed?.connectorId === connectorId && parsed.kind !== null;
        };
        const allowedTargets = (allowedIds ?? []).filter(inConnector);
        const targetIds = [
          ...new Set([
            ...allowedTargets,
            ...combinedIds.filter(inConnector),
            ...seenIds.filter(inConnector),
          ]),
        ];
        const connectorSelected = combinedIds.includes(connectorId);
        if (!connectorAllowed && allowedTargets.length === 0 && !connectorSelected) {
          if (!targetIds.some((id) => combinedIds.includes(id))) return null;
        }
        const connectorInherited = inheritedSet.has(connectorId);
        // Without the connector itself, it is only context for the targets below it.
        const connectorDisabled =
          !!disabled ||
          !onToggle ||
          connectorInherited ||
          (!connectorSelected && !connectorAllowed);
        const isAllowed = (target: { qualifier: string; path: string | null }) =>
          connectorAllowed || gitTargetCovered({ connectorId, ...target }, allowedTargets, pathOf);
        const isCovered = (target: { qualifier: string; path: string | null }) =>
          gitTargetCovered(
            { connectorId, ...target },
            combinedIds.filter((id) => id !== target.qualifier),
            pathOf
          );
        const canNarrow =
          targetKinds.length > 0 &&
          !!connector &&
          !connectorSelected &&
          !disabled &&
          !!onToggle &&
          (connectorAllowed ||
            allowedTargets.some((id) => {
              const kind = parseGitQualifier(id)?.kind;
              return kind === "group" || kind === "owner";
            }));

        return (
          <div key={connectorId}>
            <label
              className={cn(
                "flex items-center gap-2 py-0.5 text-xs",
                connectorDisabled ? "cursor-default opacity-60" : "cursor-pointer"
              )}
            >
              <input
                type="checkbox"
                checked={connectorSelected}
                onChange={() => !connectorDisabled && toggle(connectorId)}
                disabled={connectorDisabled}
                className="form-checkbox"
              />
              <span>{labelOf(connectorId)}</span>
              <span className="text-xs text-muted-foreground">connector</span>
              {connectorInherited && showInherited && (
                <span className="text-xs text-muted-foreground">inherited</span>
              )}
            </label>
            {targetIds.map((qualifier) => {
              const parsed = parseGitQualifier(qualifier)!;
              const target = { qualifier, path: pathOf(qualifier) };
              const covered = isCovered(target);
              const checked = covered || combinedIds.includes(qualifier);
              const inherited = inheritedSet.has(qualifier);
              const optionDisabled =
                !!disabled ||
                !onToggle ||
                covered ||
                inherited ||
                // A stored target outside the grant can still be removed, never added back.
                (!checked && !isAllowed(target));
              return (
                <label
                  key={qualifier}
                  className={cn(
                    "flex items-center gap-2 py-0.5 pl-5 text-xs",
                    optionDisabled ? "cursor-default opacity-60" : "cursor-pointer"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => !optionDisabled && toggle(qualifier)}
                    disabled={optionDisabled}
                    className="form-checkbox"
                  />
                  <span className="min-w-0 break-all">{labelOf(qualifier)}</span>
                  {parsed.kind && (
                    <span className="text-xs text-muted-foreground">
                      {GIT_TARGET_KIND_LABELS[parsed.kind]}
                    </span>
                  )}
                  {inherited && showInherited && (
                    <span className="text-xs text-muted-foreground">inherited</span>
                  )}
                </label>
              );
            })}
            {canNarrow && connector && (
              <div className="py-0.5 pl-5 text-xs">
                <GitScopeTargetPicker
                  provider={provider}
                  connector={connector}
                  scopeLabel={scopeLabel}
                  stateOf={(option) => {
                    const qualifier = gitQualifier(connectorId, option.kind, option.id);
                    const target = { qualifier, path: option.path };
                    const covered = isCovered(target);
                    return {
                      checked: covered || combinedIds.includes(qualifier),
                      disabled: covered || inheritedSet.has(qualifier),
                      allowed: isAllowed(target),
                    };
                  }}
                  onPick={(option) => {
                    const qualifier = gitQualifier(connectorId, option.kind, option.id);
                    onRememberLabels({
                      [gitLabelKey(provider, qualifier)]: { label: option.path, missing: false },
                    });
                    toggle(qualifier);
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

interface GitScopeTargetPickerProps {
  provider: GitScopeProvider;
  connector: GitScopeConnector;
  scopeLabel: string;
  stateOf: (option: GitScopeTargetOption) => {
    checked: boolean;
    disabled: boolean;
    allowed: boolean;
  };
  onPick: (option: GitScopeTargetOption) => void;
}

/** Searchable picker over one connector's groups and projects, or owners and repositories. */
function GitScopeTargetPicker({
  provider,
  connector,
  scopeLabel,
  stateOf,
  onPick,
}: GitScopeTargetPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // null until the first response after opening: the list shows a loader in its place.
  const [results, setResults] = useState<{
    query: string;
    options: GitScopeTargetOption[];
    truncated?: GitScopeTargetTruncation;
    error: string | null;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const hasResults = useRef(false);
  const noun = GIT_PROVIDER_TARGET_NOUNS[provider];
  const query = search.trim();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        setSearching(true);
        searchGitScopeTargets(provider, connector.id, query)
          .then(({ options, truncated }) => {
            if (!cancelled) setResults({ query, options, truncated, error: null });
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setResults({
              query,
              options: [],
              error: error instanceof Error ? error.message : `Could not search ${noun}`,
            });
          })
          .finally(() => {
            if (cancelled) return;
            hasResults.current = true;
            setSearching(false);
          });
      },
      // Opening lists at once; typing waits for a pause.
      hasResults.current ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, provider, connector.id, query, noun]);

  const present = useDialogPresence(open);
  useEffect(() => {
    if (present) return;
    setSearch("");
    setResults(null);
    setSearching(false);
    hasResults.current = false;
  }, [present]);

  const options = (results?.options ?? []).filter((option) => stateOf(option).allowed);
  const refreshing = results !== null && (searching || results.query !== query);
  const truncationHint = results?.error ? null : gitScopeTruncationHint(results?.truncated);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="quiet"
          size="inline"
          aria-label={`Add ${noun} from ${connector.name} to ${scopeLabel}`}
        >
          Add {noun}…
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        // A modal dialog behind the picker turns pointer events off for the page.
        style={{ pointerEvents: "auto" }}
        className="w-80 max-w-[var(--radix-popover-content-available-width)] p-0"
      >
        <div className="relative border-b border-border p-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search ${noun} by name or path in ${connector.name}`}
            aria-label={`Search ${noun} in ${connector.name}`}
            className="pr-9"
          />
          {refreshing && (
            <span
              role="status"
              aria-label={`Searching ${noun}`}
              className="pointer-events-none absolute inset-y-0 right-4 flex items-center"
            >
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </span>
          )}
        </div>
        {/* A fixed height keeps the picker still while results load and change. */}
        <div className="h-64 overflow-y-auto overscroll-contain p-1">
          {results === null ? (
            <LoadingSpinner className="h-full" label={`Loading ${noun}`} />
          ) : results.error ? (
            <p className="px-2 py-1.5 text-sm text-destructive">{results.error}</p>
          ) : options.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {results.options.length > 0
                ? "None of these are within your access. Search by path to find more."
                : results.query
                  ? `Nothing matches “${results.query}”.`
                  : `No ${noun} found.`}
            </p>
          ) : (
            GIT_PROVIDER_TARGET_KINDS[provider].map((kind) => {
              const section = options.filter((option) => option.kind === kind);
              if (section.length === 0) return null;
              return (
                <div key={kind} role="group" aria-label={SECTION_LABELS[kind]}>
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    {SECTION_LABELS[kind]}
                  </div>
                  {section.map((option) => {
                    const state = stateOf(option);
                    return (
                      // Structural option row of the picker list, like Combobox options.
                      <button
                        key={`${option.kind}:${option.id}`}
                        type="button"
                        aria-pressed={state.checked}
                        disabled={state.disabled}
                        onClick={() => onPick(option)}
                        className={cn(
                          selectItemClassName,
                          "gap-2 text-left hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{option.path}</span>
                        <span className="text-xs text-muted-foreground">
                          {option.detail ?? GIT_TARGET_KIND_LABELS[option.kind]}
                        </span>
                        {state.checked ? <SelectItemCheck /> : null}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        {truncationHint && (
          <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
            {truncationHint}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
