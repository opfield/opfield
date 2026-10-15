// Pieces the resource tabs share: type definitions, the create/import header actions, the headers
// of types not in the app yet, the empty group and the member row-menu entries.
import {
  Box,
  Boxes,
  Database,
  Globe,
  Globe2,
  HardDrive,
  Import,
  Link2,
  Lock,
  Plus,
  ScrollText,
} from "lucide-react";
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
  /** The section's icon, also on its header while it is empty. */
  icon: ReactNode;
}

export const TYPES = {
  containers: {
    key: "containers",
    title: "Containers and deployments",
    create: "Deploy",
    addLabel: "Container or deployment",
    createType: "container",
    importFamily: "containers",
    icon: <Box className="h-4 w-4" />,
  },
  compose: {
    key: "compose",
    title: "Compose projects",
    create: "New Project",
    addLabel: "Compose project",
    createType: "compose",
    importFamily: "compose",
    icon: <Boxes className="h-4 w-4" />,
  },
  pages: {
    key: "pages",
    title: "Pages projects",
    create: "Create project",
    addLabel: "Pages project",
    createType: "pages",
    importFamily: "pages",
    icon: <Globe2 className="h-4 w-4" />,
  },
  databases: {
    key: "databases",
    title: "Databases",
    create: "Deploy database",
    addLabel: "Database",
    createType: "database",
    importFamily: "databases",
    icon: <Database className="h-4 w-4" />,
  },
  storage: {
    key: "storage",
    title: "Storage",
    create: "Deploy storage",
    addLabel: "Storage",
    createType: "storage",
    importFamily: "storage",
    icon: <HardDrive className="h-4 w-4" />,
  },
  logging: {
    key: "logging",
    title: "Logging environments",
    create: "Create Environment",
    addLabel: "Logging environment",
    createType: "logging",
    importFamily: "logging",
    icon: <ScrollText className="h-4 w-4" />,
  },
  routes: {
    key: "routes",
    title: "Routes",
    create: "Add Route",
    addLabel: "Route",
    createType: "route",
    importFamily: "routes",
    icon: <Globe className="h-4 w-4" />,
  },
  domains: {
    key: "domains",
    title: "Domains",
    create: "Add Domain",
    addLabel: "Domain",
    createType: "domain",
    importFamily: "domains",
    icon: <Globe2 className="h-4 w-4" />,
  },
  certificates: {
    key: "certificates",
    title: "SSL certificates",
    create: "Add Certificate",
    addLabel: "SSL certificate",
    createType: "certificate",
    importFamily: "certificates",
    icon: <Lock className="h-4 w-4" />,
  },
  links: {
    key: "links",
    title: "Container links",
    create: "Add link",
    addLabel: "Container link",
    createType: "container-link",
    importFamily: null,
    icon: <Link2 className="h-4 w-4" />,
  },
} satisfies Record<string, TypeDef>;

/** What a tab can ask the page for. */
export interface TabActions {
  /** May create or import something (a family's create grant, or apps:env:manage, in some environment). */
  canCreate: boolean;
  onCreate: (type: AppCreateType, environmentId?: string | null) => void;
  onImport: (family: AppMemberFamily) => void;
  /** The license plan includes creating this type (wording of empty states). */
  planCreates: (type: AppCreateType) => boolean;
  /** The plan includes the type and the user may create it in some environment (entry points). */
  creates: (type: AppCreateType) => boolean;
  /** The plan includes importing this family and the user may place members (apps:env:manage). */
  imports: (family: AppMemberFamily) => boolean;
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
  const canImport = type.importFamily !== null && actions.imports(type.importFamily);
  const canCreate = actions.creates(type.createType);
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

/** Types of a tab with no members yet: their section header alone, with its create and import actions. */
export function AddRow({ types, actions }: { types: TypeDef[]; actions: TabActions }) {
  return (
    <>
      {types
        .filter(
          (type) =>
            actions.creates(type.createType) ||
            (type.importFamily !== null && actions.imports(type.importFamily))
        )
        .map((type) => (
          <PanelShell
            key={type.key}
            title={<CountTitle title={type.title} count={0} />}
            icon={type.icon}
            description="Nothing here yet"
            actions={<TypeActions type={type} actions={actions} />}
          />
        ))}
    </>
  );
}

/** A whole tab is empty: the overflow menu (other creates and imports), Import existing, then the first create action. */
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
  const [first, ...rest] = types.filter((type) => actions.creates(type.createType));
  const [firstImport, ...restImports] = types.filter(
    (type) => type.importFamily !== null && actions.imports(type.importFamily)
  );
  return (
    <PanelShell
      title={title}
      icon={icon}
      description="Nothing here yet"
      actions={
        actions.canCreate && (first || firstImport) ? (
          <>
            {rest.length + restImports.length > 0 && (
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
                {restImports.length > 0 && rest.length > 0 && <DropdownMenuSeparator />}
                {restImports.map((type) => (
                  <DropdownMenuItem
                    key={`import-${type.key}`}
                    onClick={() => actions.onImport(type.importFamily as AppMemberFamily)}
                  >
                    <Import className="h-4 w-4" />
                    Import existing {type.title.toLowerCase()}
                  </DropdownMenuItem>
                ))}
              </MoreMenu>
            )}
            {firstImport && (
              <Button
                variant="outline"
                title={`Import existing ${firstImport.title.toLowerCase()}`}
                onClick={() => actions.onImport(firstImport.importFamily as AppMemberFamily)}
              >
                <Import className="h-3.5 w-3.5" />
                Import existing
              </Button>
            )}
            {first && (
              <Button onClick={() => actions.onCreate(first.createType)}>
                <Plus className="h-3.5 w-3.5" />
                {first.addLabel}
              </Button>
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
