// Pieces the resource tabs share: type definitions, the create/import header actions, the row
// for types not in the app yet, the empty group and the member row-menu entries.
import { Import, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import type { AppDetail, AppMemberFamily, AppMemberType } from "@/types";
import type { AppCreateType } from "../AppCreateDialogs";
import { CountTitle, type EnvGroup, GroupedList, groupTotal, MoreMenu } from "../app-shared";

export interface TypeDef {
  key: string;
  title: string;
  /** The list's own create action. */
  create: string;
  /** Label in New / AddRow / an empty group. */
  addLabel: string;
  createType: AppCreateType;
  /** Import existing (container links have none). */
  importFamily: AppMemberFamily | null;
}

export const TYPES = {
  containers: {
    key: "containers",
    title: "Containers and deployments",
    create: "Deploy",
    addLabel: "Container or deployment",
    createType: "container",
    importFamily: "containers",
  },
  compose: {
    key: "compose",
    title: "Compose projects",
    create: "New Project",
    addLabel: "Compose project",
    createType: "compose",
    importFamily: "compose",
  },
  pages: {
    key: "pages",
    title: "Pages projects",
    create: "Create project",
    addLabel: "Pages project",
    createType: "pages",
    importFamily: "pages",
  },
  databases: {
    key: "databases",
    title: "Databases",
    create: "Deploy database",
    addLabel: "Database",
    createType: "database",
    importFamily: "databases",
  },
  storage: {
    key: "storage",
    title: "Storage",
    create: "Deploy storage",
    addLabel: "Storage",
    createType: "storage",
    importFamily: "storage",
  },
  routes: {
    key: "routes",
    title: "Routes",
    create: "Add Route",
    addLabel: "Route",
    createType: "route",
    importFamily: "routes",
  },
  links: {
    key: "links",
    title: "Container links",
    create: "Add link",
    addLabel: "Container link",
    createType: "container-link",
    importFamily: null,
  },
} satisfies Record<string, TypeDef>;

/** What a tab can ask the page for. */
export interface TabActions {
  /** May create / import (env:manage on some environment). */
  canCreate: boolean;
  onCreate: (type: AppCreateType, environmentId?: string | null) => void;
  onImport: (family: AppMemberFamily) => void;
  /** The license plan includes creating this type (entry points of other types stay hidden). */
  planCreates: (type: AppCreateType) => boolean;
  /** The license plan includes importing existing members of this family. */
  planImports: (family: AppMemberFamily) => boolean;
  /** May move members of this environment. */
  canMoveIn: (environmentId: string) => boolean;
  onMoveToEnvironment: (member: MemberRef) => void;
  onMoveToApp: (member: MemberRef) => void;
}

/** A member row as the move dialogs need it. */
export interface MemberRef {
  type: AppMemberType;
  id: string;
  nodeId?: string | null;
  name: string;
  environmentId: string;
}

/** Import existing + the list's create action, in a type section's header. */
export function TypeActions({ type, actions }: { type: TypeDef; actions: TabActions }) {
  const canImport = type.importFamily !== null && actions.planImports(type.importFamily);
  const canCreate = actions.planCreates(type.createType);
  if (!canImport && !canCreate) return null;
  return (
    <>
      {canImport && (
        <Button
          variant="outline"
          onClick={() => actions.onImport(type.importFamily as AppMemberFamily)}
        >
          <Import className="h-3.5 w-3.5" />
          Import existing
        </Button>
      )}
      {canCreate && (
        <Button onClick={() => actions.onCreate(type.createType)}>
          <Plus className="h-3.5 w-3.5" />
          {type.create}
        </Button>
      )}
    </>
  );
}

/** Missing types of a tab: one compact row instead of empty panels. */
export function AddRow({ types, actions }: { types: TypeDef[]; actions: TabActions }) {
  const creatable = types.filter((type) => actions.planCreates(type.createType));
  const importable = types.find(
    (type) => type.importFamily !== null && actions.planImports(type.importFamily)
  );
  if (creatable.length === 0 && !importable) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border border-border bg-card px-4 py-3">
      <span className="mr-2 text-sm text-muted-foreground">Not in the app yet:</span>
      {creatable.map((type) => (
        <Button key={type.key} variant="outline" onClick={() => actions.onCreate(type.createType)}>
          <Plus className="h-3.5 w-3.5" />
          {type.addLabel}
        </Button>
      ))}
      {importable && (
        <Button
          variant="link"
          className="ml-auto h-auto p-0"
          onClick={() => actions.onImport(importable.importFamily as AppMemberFamily)}
        >
          Import existing
        </Button>
      )}
    </div>
  );
}

/** A whole tab is empty: the first create action, the rest in the overflow menu. */
export function EmptyGroup({
  title,
  icon,
  types,
  message,
  actions,
}: {
  title: string;
  icon: ReactNode;
  types: TypeDef[];
  message: string;
  actions: TabActions;
}) {
  const [first, ...rest] = types.filter((type) => actions.planCreates(type.createType));
  const importable = types.filter(
    (type) => type.importFamily !== null && actions.planImports(type.importFamily)
  );
  return (
    <PanelShell
      title={title}
      icon={icon}
      description="Nothing here yet"
      actions={
        actions.canCreate && (first || importable.length > 0) ? (
          <>
            {first && (
              <Button onClick={() => actions.onCreate(first.createType)}>
                <Plus className="h-3.5 w-3.5" />
                {first.addLabel}
              </Button>
            )}
            {rest.length + importable.length > 0 && (
              <MoreMenu label={`More ${title} actions`}>
                {rest.map((type) => (
                  <DropdownMenuItem
                    key={type.key}
                    onClick={() => actions.onCreate(type.createType)}
                  >
                    <Plus className="h-4 w-4" />
                    {type.addLabel}
                  </DropdownMenuItem>
                ))}
                {importable.length > 0 && rest.length > 0 && <DropdownMenuSeparator />}
                {importable.map((type) => (
                  <DropdownMenuItem
                    key={`import-${type.key}`}
                    onClick={() => actions.onImport(type.importFamily as AppMemberFamily)}
                  >
                    <Import className="h-4 w-4" />
                    {importable.length === 1
                      ? "Import existing"
                      : `Import ${type.title.toLowerCase()}`}
                  </DropdownMenuItem>
                ))}
              </MoreMenu>
            )}
          </>
        ) : undefined
      }
    >
      <EmptyState
        message={message}
        embedded
        {...(actions.canCreate && first
          ? { actionLabel: first.addLabel, onAction: () => actions.onCreate(first.createType) }
          : {})}
      />
    </PanelShell>
  );
}

/** Row menu entries every member has inside an app. */
export function MemberMenuItems({ member, actions }: { member: MemberRef; actions: TabActions }) {
  if (!actions.canMoveIn(member.environmentId)) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => actions.onMoveToEnvironment(member)}>
        Move to environment...
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => actions.onMoveToApp(member)}>
        Move to app...
      </DropdownMenuItem>
    </>
  );
}

export function present<T>(items: Array<T | false | null | undefined>): T[] {
  return items.filter(Boolean) as T[];
}

/** One PanelShell per type: its list grouped by environment. */
export function TypeSection<T>({
  app,
  title,
  description,
  icon,
  headerActions,
  columns,
  groups,
  rowKey,
  onRowClick,
}: {
  app: AppDetail;
  title: string;
  description: string;
  icon: ReactNode;
  headerActions?: ReactNode;
  columns: ResourceListColumn<T>[];
  groups: EnvGroup<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
}) {
  return (
    <PanelShell
      title={<CountTitle title={title} count={groupTotal(groups)} />}
      icon={icon}
      description={description}
      actions={headerActions}
    >
      <GroupedList
        appSlug={app.slug}
        columns={columns}
        groups={groups}
        rowKey={rowKey}
        onRowClick={onRowClick}
      />
    </PanelShell>
  );
}
