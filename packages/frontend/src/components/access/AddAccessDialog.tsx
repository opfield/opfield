import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import {
  type GitScopeTargetOption,
  gitScopeTruncationHint,
  searchGitScopeTargets,
} from "@/components/common/git-scope-targets";
import { SwitchCard } from "@/components/common/SwitchCard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { GitScopeProvider } from "@/types";
import { AccessDialogFooter } from "./AccessDialogFooter";
import type { AccessCatalog } from "./access-catalog";
import {
  ACCESS_ROLES,
  ACCESS_TYPE_IDS,
  ACCESS_TYPES,
  type AccessContext,
  type AccessLine,
  type AccessRole,
  type AccessTypeId,
  type AccessWhere,
  APP_ACCESS_TYPE_IDS,
  accessApp,
  accessFolderPaths,
  accessType,
  appMemberCount,
  coversLabel,
  folderPathLabel,
  GIT_LEVELS,
  GIT_PROVIDER_TITLES,
  GIT_TARGET_KINDS,
  type GitLevel,
  lineScopes,
  narrowedNote,
  placeTypeIds,
  principalHolds,
  roleCanDelete,
  tokenStoredScopes,
  typesManagingFolders,
  typesText,
  typesWithoutFolder,
} from "./access-model";

const SEARCH_DEBOUNCE_MS = 300;
const PROVIDERS: readonly GitScopeProvider[] = ["gitlab", "github", "git"];

type WhereKind = AccessWhere["kind"];
type RepositoriesKind = "all" | "group" | "some";

interface Draft {
  tab: "resources" | "git";
  role: AccessRole;
  where: WhereKind;
  folder: string;
  /** `<appId>:<envId>`, or `<appId>:*` for every environment of the app. */
  app: string;
  /** `<type>:<id>` of picked resources. */
  resources: string[];
  types: AccessTypeId[];
  mayDelete: boolean;
  /** Folder lines: also manage the folder's subfolders. */
  manageFolders: boolean;
  /** `<provider>:<connectorId>`, or `<provider>:*` for every connector of the provider. */
  connector: string;
  repositories: RepositoriesKind;
  group: string;
  repos: string[];
  level: GitLevel;
}

function appKey(where: Extract<AccessWhere, { kind: "app" }>) {
  return `${where.appId}:${where.envId ?? "*"}`;
}

function splitAppKey(value: string): Extract<AccessWhere, { kind: "app" }> | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const envId = value.slice(separator + 1);
  return { kind: "app", appId: value.slice(0, separator), envId: envId === "*" ? null : envId };
}

/** "<App> · every environment" and "<App> · <env>" per app the user can see. */
function appOptions(ctx: AccessContext) {
  return (ctx.apps ?? []).flatMap((app) => [
    { value: `${app.id}:*`, label: `${app.name} · every environment` },
    ...app.environments.map((environment) => ({
      value: `${app.id}:${environment.id}`,
      label: `${app.name} · ${environment.name}`,
    })),
  ]);
}

function draftFor(line: AccessLine | null, firstApp: string, firstConnector: string): Draft {
  const draft: Draft = {
    tab: "resources",
    role: "developer",
    // A new line starts at the broadest place; a folder is picked deliberately, since a
    // preselected one silently left out every type without that folder.
    where: "everywhere",
    folder: "",
    app: firstApp,
    resources: [],
    types: [...ACCESS_TYPE_IDS],
    mayDelete: false,
    manageFolders: false,
    connector: firstConnector,
    repositories: "all",
    group: "",
    repos: [],
    level: "use",
  };
  if (line?.kind === "resources") {
    const { where } = line;
    return {
      ...draft,
      role: line.role,
      where: where.kind,
      folder: where.kind === "folder" ? where.path : draft.folder,
      app: where.kind === "app" ? appKey(where) : draft.app,
      resources:
        where.kind === "resources"
          ? (Object.keys(where.ids) as AccessTypeId[]).flatMap((type) =>
              (where.ids[type] ?? []).map((id) => `${type}:${id}`)
            )
          : [],
      types: [...line.types],
      mayDelete: line.mayDelete,
      manageFolders: !!line.manageFolders,
    };
  }
  if (line?.kind === "git") {
    return {
      ...draft,
      tab: "git",
      connector: `${line.provider}:${line.connectorId ?? "*"}`,
      repositories: line.repositories.kind,
      group: line.repositories.kind === "group" ? line.repositories.id : "",
      repos: line.repositories.kind === "some" ? [...line.repositories.ids] : [],
      level: line.level,
    };
  }
  return draft;
}

function splitConnector(value: string): { provider: GitScopeProvider; connectorId: string | null } {
  const separator = value.indexOf(":");
  const provider = value.slice(0, separator) as GitScopeProvider;
  const id = value.slice(separator + 1);
  return { provider, connectorId: id === "*" ? null : id };
}

/** The line a draft stands for, or null while it is incomplete. */
function lineFor(
  draft: Draft,
  folderTypes: (types: AccessTypeId[]) => AccessTypeId[]
): AccessLine | null {
  if (draft.tab === "git") {
    if (!draft.connector) return null;
    const { provider, connectorId } = splitConnector(draft.connector);
    const repositories =
      connectorId === null || draft.repositories === "all"
        ? ({ kind: "all" } as const)
        : draft.repositories === "group"
          ? draft.group
            ? ({ kind: "group", id: draft.group } as const)
            : null
          : draft.repos.length > 0
            ? ({ kind: "some", ids: [...draft.repos].sort() } as const)
            : null;
    if (!repositories) return null;
    return { kind: "git", provider, connectorId, repositories, level: draft.level };
  }
  const mayDelete = draft.mayDelete && roleCanDelete(draft.role);
  if (draft.where === "everywhere") {
    if (draft.types.length === 0) return null;
    return {
      kind: "resources",
      role: draft.role,
      types: sortTypes(draft.types),
      where: { kind: "everywhere" },
      mayDelete,
    };
  }
  if (draft.where === "app") {
    const where = splitAppKey(draft.app);
    const types = sortTypes(draft.types.filter((type) => APP_ACCESS_TYPE_IDS.includes(type)));
    if (!where || types.length === 0) return null;
    return { kind: "resources", role: draft.role, types, where, mayDelete };
  }
  if (draft.where === "folder") {
    const types = folderTypes(draft.types);
    if (!draft.folder || types.length === 0) return null;
    const manageFolders = draft.manageFolders && typesManagingFolders(types).length > 0;
    return {
      kind: "resources",
      role: draft.role,
      types,
      where: { kind: "folder", path: draft.folder },
      mayDelete,
      ...(manageFolders ? { manageFolders } : {}),
    };
  }
  const ids: Partial<Record<AccessTypeId, string[]>> = {};
  for (const key of draft.resources) {
    const separator = key.indexOf(":");
    const type = key.slice(0, separator) as AccessTypeId;
    if (!draft.types.includes(type)) continue;
    ids[type] = [...(ids[type] ?? []), key.slice(separator + 1)];
  }
  const types = sortTypes(Object.keys(ids) as AccessTypeId[]);
  if (types.length === 0) return null;
  return {
    kind: "resources",
    role: draft.role,
    types,
    where: { kind: "resources", ids },
    mayDelete,
  };
}

function sortTypes(types: readonly AccessTypeId[]) {
  return ACCESS_TYPE_IDS.filter((type) => types.includes(type));
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}

/** Groups (or owners) or repositories of one connector, searched as the user types. */
function useGitTargets(
  provider: GitScopeProvider,
  connectorId: string | null,
  kind: "container" | "repository",
  enabled: boolean,
  query: string
) {
  const [options, setOptions] = useState<GitScopeTargetOption[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const wanted = GIT_TARGET_KINDS[provider]?.[kind];
  useEffect(() => {
    if (!enabled || !connectorId || !wanted) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchGitScopeTargets(provider, connectorId, query)
        .then((result) => {
          if (cancelled) return;
          setOptions(result.options.filter((option) => option.kind === wanted));
          setHint(gitScopeTruncationHint(result.truncated));
        })
        .catch(() => {
          if (!cancelled) setOptions([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connectorId, enabled, provider, query, wanted]);
  return { options, hint };
}

/** How many repositories a group (or owner) holds now, as far as a search finds them. */
function useGroupRepositoryCount(
  provider: GitScopeProvider,
  connectorId: string | null,
  path: string | undefined
) {
  const [count, setCount] = useState<string | null>(null);
  useEffect(() => {
    setCount(null);
    const kinds = GIT_TARGET_KINDS[provider];
    if (!connectorId || !path || !kinds) return;
    let cancelled = false;
    void searchGitScopeTargets(provider, connectorId, path)
      .then((result) => {
        if (cancelled) return;
        const prefix = `${path.toLowerCase()}/`;
        const repos = result.options.filter(
          (option) =>
            option.kind === kinds.repository && option.path.toLowerCase().startsWith(prefix)
        ).length;
        setCount(`${repos}${result.truncated ? "+" : ""}`);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connectorId, path, provider]);
  return count;
}

export type AccessGrantMode =
  /** A group or a user: the actor can only give what it holds; the backend refuses the rest. */
  | { kind: "grant"; actorScopes: readonly string[] }
  /** A token: a line wider than its owner works as the owner's access. */
  | { kind: "token"; ownerScopes: readonly string[] };

interface AddAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Who gets the access, for the description ("For orders-team."). */
  subject: string;
  /** The line being edited; null adds one. */
  line: AccessLine | null;
  catalog: AccessCatalog;
  mode: AccessGrantMode;
  onSave: (line: AccessLine) => void;
  /** Opens the scope picker with the draft's scopes. */
  onReviewScopes: (scopes: string[]) => void;
}

/** Adds or edits one access line: a role in a place, or a Git level on repositories. */
export function AddAccessDialog({
  open,
  onOpenChange,
  subject,
  line,
  catalog,
  mode,
  onSave,
  onReviewScopes,
}: AddAccessDialogProps) {
  const { ctx, labels, gitConnectors, resources, loadResources, rememberGitLabel } = catalog;
  const folderPaths = useMemo(() => accessFolderPaths(ctx), [ctx]);
  const folderOptions = useMemo<ComboboxOption[]>(
    () => folderPaths.map((path) => ({ value: path, label: folderPathLabel(path) })),
    [folderPaths]
  );
  const connectorOptions = useMemo(
    () =>
      PROVIDERS.flatMap((provider) => {
        const connectors = gitConnectors[provider];
        if (!connectors || connectors.length === 0) return [];
        const title = GIT_PROVIDER_TITLES[provider];
        return [
          { value: `${provider}:*`, label: `Every ${title} connector` },
          ...connectors.map((connector) => ({
            value: `${provider}:${connector.id}`,
            label: `${title} · ${connector.name}`,
          })),
        ];
      }),
    [gitConnectors]
  );
  const apps = useMemo(() => appOptions(ctx), [ctx]);
  const [draft, setDraft] = useState<Draft>(() => draftFor(line, apps[0]?.value ?? "", ""));
  const [groupQuery, setGroupQuery] = useState("");
  const [repoQuery, setRepoQuery] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: Each opening starts from the line it edits.
  useEffect(() => {
    if (!open) return;
    setDraft(draftFor(line, apps[0]?.value ?? "", connectorOptions[0]?.value ?? ""));
    setGroupQuery("");
    setRepoQuery("");
  }, [open, line]);

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const { provider, connectorId } = draft.connector
    ? splitConnector(draft.connector)
    : { provider: "gitlab" as const, connectorId: null };
  const kinds = GIT_TARGET_KINDS[provider];
  const groups = useGitTargets(
    provider,
    connectorId,
    "container",
    draft.repositories === "group",
    groupQuery
  );
  const repos = useGitTargets(
    provider,
    connectorId,
    "repository",
    draft.repositories === "some",
    repoQuery
  );
  const qualifierOf = (kind: "container" | "repository", id: string) =>
    kinds && connectorId ? `${connectorId}/${kinds[kind]}/${id}` : id;
  const groupPath = draft.group
    ? labels.gitTarget?.(provider, qualifierOf("container", draft.group))
    : undefined;
  const groupRepositoryCount = useGroupRepositoryCount(
    provider,
    draft.repositories === "group" ? connectorId : null,
    groupPath
  );

  const missingFolderTypes =
    draft.where === "folder" && draft.folder
      ? typesWithoutFolder(ctx, draft.folder, draft.types)
      : [];
  const result = lineFor(draft, (types) =>
    sortTypes(types.filter((type) => !missingFolderTypes.includes(type)))
  );
  const scopes = result ? lineScopes(result, ctx) : [];
  // What the line saves as: on a token, the owner's part of it.
  const savedScopes =
    mode.kind === "token" ? tokenStoredScopes(scopes, mode.ownerScopes, ctx) : scopes;
  const note = (() => {
    if (!result) return null;
    if (mode.kind === "token") return narrowedNote(result, mode.ownerScopes, ctx, labels);
    const lacking = scopes.filter((scope) => !principalHolds(mode.actorScopes, scope, ctx));
    return lacking.length > 0
      ? `You can't grant this: you lack ${lacking.length} of its ${scopes.length} scopes.`
      : null;
  })();

  useEffect(() => {
    if (open && draft.tab === "resources" && draft.where === "resources") loadResources();
  }, [draft.tab, draft.where, loadResources, open]);

  const resourceOptions: ComboboxOption[] = (resources ?? [])
    .filter((resource) => draft.types.includes(resource.type))
    .map((resource) => ({
      value: `${resource.type}:${resource.id}`,
      label: resource.label,
      group: accessType(resource.type).title,
    }));
  const resourceLabel = (key: string) =>
    resourceOptions.find((option) => option.value === key)?.label ??
    key.slice(key.indexOf(":") + 1);

  const groupOptions: ComboboxOption[] = [
    ...groups.options.map((option) => ({ value: option.id, label: option.path })),
    ...(draft.group && !groups.options.some((option) => option.id === draft.group)
      ? [{ value: draft.group, label: groupPath ?? draft.group }]
      : []),
  ];
  const repoLabel = (id: string) =>
    labels.gitTarget?.(provider, qualifierOf("repository", id)) ?? id;
  const repoOptions: ComboboxOption[] = [
    ...repos.options.map((option) => ({ value: option.id, label: option.path })),
    ...draft.repos
      .filter((id) => !repos.options.some((option) => option.id === id))
      .map((id) => ({ value: id, label: repoLabel(id) })),
  ];
  const containerNoun = kinds?.container === "owner" ? "owner" : "group";
  const repositoryHint =
    draft.repositories === "all"
      ? connectorId
        ? "Every repository of this connector, now and later."
        : `Every repository of every ${GIT_PROVIDER_TITLES[provider]} connector, now and later.`
      : draft.repositories === "group"
        ? draft.group
          ? `${groupRepositoryCount ?? "Its"} repositories now, and the ones created in the ${containerNoun} later.`
          : null
        : "Only these repositories.";

  const typeChoices = placeTypeIds({ kind: draft.where });
  const coveredTypes = draft.types.filter((type) => typeChoices.includes(type));
  const appWhere = draft.where === "app" ? splitAppKey(draft.app) : null;
  const appHint = (() => {
    if (!appWhere) return null;
    const app = accessApp(ctx, appWhere.appId);
    if (!app) return null;
    const count = appMemberCount(ctx, appWhere, coveredTypes);
    const resources = `${count} resource${count === 1 ? "" : "s"}`;
    if (appWhere.envId === null) {
      return app.rootFolderIds
        ? `The ${resources} of every ${app.name} environment now, and the ones created later, also in new environments.`
        : `The ${resources} of ${app.name}'s environments now, and the ones created there later.`;
    }
    const environment = app.environments.find((item) => item.id === appWhere.envId);
    return `The ${resources} of ${app.name}'s ${environment?.name ?? "environment"} now, and the ones created there later.`;
  })();

  const save = () => {
    if (!result) return;
    onSave(result);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{line ? "Edit Access" : "Add Access"}</DialogTitle>
        </DialogHeader>
        <DialogDescription>For {subject}.</DialogDescription>
        <div className="space-y-4">
          <Tabs value={draft.tab} onValueChange={(value) => update({ tab: value as Draft["tab"] })}>
            <TabsList>
              <TabsTrigger value="resources">Resources</TabsTrigger>
              <TabsTrigger value="git">Git repositories</TabsTrigger>
            </TabsList>
          </Tabs>
          {draft.tab === "resources" ? (
            <>
              <Field label="Role">
                <Select
                  value={draft.role}
                  onValueChange={(value) => update({ role: value as AccessRole })}
                >
                  <SelectTrigger aria-label="Role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCESS_ROLES.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {ACCESS_ROLES.find((role) => role.id === draft.role)?.summary}
                </p>
              </Field>
              <Field label="Where">
                {/* Everywhere has no second choice: the select takes the whole row. */}
                <div
                  className={cn(
                    "grid gap-2",
                    draft.where === "everywhere" ? "grid-cols-1" : "grid-cols-2"
                  )}
                >
                  <Select
                    value={draft.where}
                    onValueChange={(value) => update({ where: value as WhereKind })}
                  >
                    <SelectTrigger aria-label="Where">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="everywhere">Everywhere</SelectItem>
                      <SelectItem value="folder" disabled={folderPaths.length === 0}>
                        In a project folder
                      </SelectItem>
                      <SelectItem value="app" disabled={apps.length === 0}>
                        In an app environment
                      </SelectItem>
                      <SelectItem value="resources">Specific resources</SelectItem>
                    </SelectContent>
                  </Select>
                  {draft.where === "folder" ? (
                    <Combobox
                      ariaLabel="Folder"
                      value={draft.folder}
                      options={folderOptions}
                      onValueChange={(value) => update({ folder: value })}
                      placeholder="Pick a folder"
                      searchPlaceholder="Search folders..."
                    />
                  ) : draft.where === "app" ? (
                    <Select value={draft.app} onValueChange={(value) => update({ app: value })}>
                      <SelectTrigger aria-label="App environment">
                        <SelectValue placeholder="Pick an app environment" />
                      </SelectTrigger>
                      <SelectContent>
                        {apps.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : draft.where === "resources" ? (
                    <Combobox
                      multiple
                      ariaLabel="Resources"
                      value={draft.resources}
                      options={resourceOptions}
                      onValueChange={(value) => update({ resources: value })}
                      placeholder={resources === null ? "Loading resources..." : "Pick resources"}
                      searchPlaceholder="Search resources..."
                      emptyMessage="No resources of these types."
                      disabled={resources === null}
                      selectionLabel={(values) =>
                        values.length <= 2
                          ? values.map(resourceLabel).join(", ")
                          : `${values.length} resources`
                      }
                    />
                  ) : null}
                </div>
                {missingFolderTypes.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No folder {folderPathLabel(draft.folder)} for {typesText(missingFolderTypes)}:{" "}
                    {missingFolderTypes.length === 1 ? "it is" : "they are"} left out.
                  </p>
                ) : appHint ? (
                  <p className="text-xs text-muted-foreground">{appHint}</p>
                ) : draft.where === "resources" ? (
                  <p className="text-xs text-muted-foreground">
                    Only these resources, whatever folder they are in.
                  </p>
                ) : null}
              </Field>
              <Field label="Covers">
                <Combobox
                  multiple
                  ariaLabel="Covers"
                  value={coveredTypes}
                  options={ACCESS_TYPES.filter((type) => typeChoices.includes(type.id)).map(
                    (type) => ({ value: type.id, label: type.title })
                  )}
                  onValueChange={(value) =>
                    update({
                      // Types an app line cannot cover stay picked for the other places.
                      types: sortTypes([
                        ...draft.types.filter((type) => !typeChoices.includes(type)),
                        ...(value as AccessTypeId[]),
                      ]),
                    })
                  }
                  placeholder="Pick resource types"
                  searchPlaceholder="Search resource types..."
                  selectionLabel={(values) =>
                    values.length > 0 ? coversLabel(values as AccessTypeId[], typeChoices) : ""
                  }
                />
              </Field>
              <SwitchCard
                label="May delete resources"
                description={
                  roleCanDelete(draft.role)
                    ? "Off: the role can change resources but not delete them."
                    : "Developer and Operator only."
                }
                checked={draft.mayDelete && roleCanDelete(draft.role)}
                onCheckedChange={(mayDelete) => update({ mayDelete })}
                disabled={!roleCanDelete(draft.role)}
              />
              {draft.where === "folder" && typesManagingFolders(draft.types).length > 0 && (
                <SwitchCard
                  label="Manage subfolders"
                  description={
                    <>
                      Create, rename, move and delete folders inside this folder (
                      {typesText(typesManagingFolders(draft.types))}).
                    </>
                  }
                  checked={draft.manageFolders}
                  onCheckedChange={(manageFolders) => update({ manageFolders })}
                />
              )}
            </>
          ) : connectorOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Git connectors you can see.</p>
          ) : (
            <>
              <Field label="Connector">
                <Select
                  value={draft.connector}
                  onValueChange={(value) =>
                    update({ connector: value, repositories: "all", group: "", repos: [] })
                  }
                >
                  <SelectTrigger aria-label="Connector">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {connectorOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Repositories">
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={draft.repositories}
                    onValueChange={(value) => update({ repositories: value as RepositoriesKind })}
                  >
                    <SelectTrigger aria-label="Repositories">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Every repository</SelectItem>
                      <SelectItem value="group" disabled={!kinds || !connectorId}>
                        {containerNoun === "owner" ? "An owner" : "A group"}
                      </SelectItem>
                      <SelectItem value="some" disabled={!kinds || !connectorId}>
                        Some repositories
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {draft.repositories === "group" ? (
                    <Combobox
                      ariaLabel={containerNoun === "owner" ? "Owner" : "Group"}
                      value={draft.group}
                      options={groupOptions}
                      onValueChange={(value) => {
                        const option = groups.options.find((item) => item.id === value);
                        if (option)
                          rememberGitLabel(provider, qualifierOf("container", value), option.path);
                        update({ group: value });
                      }}
                      onQueryChange={setGroupQuery}
                      showAllOptionsOnFocus
                      placeholder={`Pick a ${containerNoun}`}
                      searchPlaceholder="Search by name or path..."
                      emptyMessage={groups.hint ?? undefined}
                    />
                  ) : draft.repositories === "some" ? (
                    <Combobox
                      multiple
                      ariaLabel="Repositories to grant"
                      value={draft.repos}
                      options={repoOptions}
                      onValueChange={(value) => {
                        for (const id of value) {
                          const option = repos.options.find((item) => item.id === id);
                          if (option)
                            rememberGitLabel(provider, qualifierOf("repository", id), option.path);
                        }
                        update({ repos: value });
                      }}
                      onQueryChange={setRepoQuery}
                      showAllOptionsOnFocus
                      placeholder="Pick repositories"
                      searchPlaceholder="Search by name or path..."
                      emptyMessage={repos.hint ?? undefined}
                      selectionLabel={(values) =>
                        values.length <= 2
                          ? values.map(repoLabel).join(", ")
                          : `${values.length} repositories`
                      }
                    />
                  ) : null}
                </div>
                {repositoryHint ? (
                  <p className="text-xs text-muted-foreground">{repositoryHint}</p>
                ) : null}
              </Field>
              <Field label="Access">
                <Select
                  value={draft.level}
                  onValueChange={(value) => update({ level: value as GitLevel })}
                >
                  <SelectTrigger aria-label="Git access">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GIT_LEVELS.map((level) => (
                      <SelectItem key={level.value} value={level.value}>
                        {level.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {GIT_LEVELS.find((level) => level.value === draft.level)?.hint}
                </p>
              </Field>
            </>
          )}
          {note ? <p className="text-xs text-warning-foreground">{note}</p> : null}
        </div>
        <AccessDialogFooter
          scopeCount={savedScopes.length}
          onReviewScopes={() => onReviewScopes(savedScopes)}
        >
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={!result}>
            {line ? "Save Access" : "Add Access"}
          </Button>
        </AccessDialogFooter>
      </DialogContent>
    </Dialog>
  );
}
