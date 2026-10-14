// Shared pieces of the Apps pages (canvas `.design/canvas/apps/screens/AppPage.tsx`).
import { MoreHorizontal, MoreVertical } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Notice } from "@/components/common/Notice";
import {
  ResourceListCell,
  type ResourceListColumn,
  ResourceListFrame,
  ResourceListHeaderTable,
  ResourceListRow,
  ResourceListSectionHeader,
  ResourceListTable,
  resourceListMinWidth,
} from "@/components/common/ResourceListLayout";
import { type StatusTone, statusDotClass } from "@/components/common/resource-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { appEnvironmentRoute } from "@/lib/app-routes";
import { cn } from "@/lib/utils";
import type {
  AppDetail,
  AppEnvironmentDetail,
  AppHealth,
  AppMemberCounts,
  AppMemberType,
} from "@/types";

export const HEALTH_BADGE: Record<AppHealth, "success" | "warning" | "destructive" | "secondary"> =
  {
    healthy: "success",
    degraded: "warning",
    failing: "destructive",
    unknown: "secondary",
  };

const HEALTH_TONE: Record<AppHealth, StatusTone> = {
  healthy: "success",
  degraded: "warning",
  failing: "destructive",
  unknown: "secondary",
};

export function HealthBadge({ health, inline }: { health: AppHealth; inline?: boolean }) {
  return (
    <Badge variant={HEALTH_BADGE[health]} size={inline ? "inline" : undefined} className="shrink-0">
      {health}
    </Badge>
  );
}

export const plural = (count: number, word: string, many = `${word}s`) =>
  `${count} ${count === 1 ? word : many}`;

export function memberTotal(counts: AppMemberCounts | undefined): number {
  if (!counts) return 0;
  return Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0);
}

type EnvLike = Pick<AppEnvironmentDetail, "name" | "isProduction" | "health" | "access">;

/** Health dot, the environment's name and the Production badge. */
export function EnvLabel({ env }: { env: EnvLike }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("h-2 w-2 shrink-0", statusDotClass(HEALTH_TONE[env.health]))} />
      {env.name}
      {env.isProduction && (
        <Badge variant="outline" size="inline">
          Production
        </Badge>
      )}
    </span>
  );
}

/** An environment's name as a link to its own page (a plain label when seen only through members). */
export function EnvLink({ appSlug, env }: { appSlug: string; env: EnvLike & { slug: string } }) {
  if (env.access === "members") return <EnvLabel env={env} />;
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("h-2 w-2 shrink-0", statusDotClass(HEALTH_TONE[env.health]))} />
      <Button asChild variant="link" className="h-auto p-0">
        <Link to={appEnvironmentRoute(appSlug, env.slug)}>{env.name}</Link>
      </Button>
      {env.isProduction && (
        <Badge variant="outline" size="inline">
          Production
        </Badge>
      )}
    </span>
  );
}

export function CountTitle({ title, count }: { title: string; count: number }) {
  return (
    <>
      {title}
      <Badge variant="secondary" size="inline">
        {count}
      </Badge>
    </>
  );
}

/** A shell header's overflow: everything past its two buttons. */
export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={label} title={label}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A list row's actions menu. Clicks inside do not open the row. */
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={label} title={label}>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{children}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The node monitoring tab's section heading. */
export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

/** At most four stat cards per row. */
export function CardRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

export interface EnvGroup<T> {
  env: AppEnvironmentDetail;
  rows: T[];
}

export const groupTotal = <T,>(groups: EnvGroup<T>[]) =>
  groups.reduce((sum, group) => sum + group.rows.length, 0);

/** The list's header once, then one section header per environment (a link to its page) with its rows. */
export function GroupedList<T>({
  appSlug,
  columns,
  groups,
  rowKey,
  onRowClick,
  renderRows,
  minWidth,
}: {
  appSlug: string;
  columns: ResourceListColumn<T>[];
  groups: EnvGroup<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Custom rows (Compose projects with their services). */
  renderRows?: (rows: T[]) => ReactNode;
  minWidth?: CSSProperties["minWidth"];
}) {
  return (
    <ResourceListFrame minWidth={minWidth ?? resourceListMinWidth(columns)} className="border-0">
      <ResourceListHeaderTable columns={columns} />
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <div key={group.env.id}>
            <ResourceListSectionHeader
              label={<EnvLink appSlug={appSlug} env={group.env} />}
              count={group.rows.length}
              className="bg-muted/30"
            />
            <ResourceListTable columns={columns}>
              {renderRows
                ? renderRows(group.rows)
                : group.rows.map((row) => (
                    <ResourceListRow
                      key={rowKey(row)}
                      interactive={Boolean(onRowClick)}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                    >
                      {columns.map((column) => (
                        <ResourceListCell
                          key={column.id}
                          align={column.align}
                          className={column.cellClassName}
                          contentClassName={column.cellContentClassName}
                        >
                          {column.renderCell?.(row)}
                        </ResourceListCell>
                      ))}
                    </ResourceListRow>
                  ))}
            </ResourceListTable>
          </div>
        ))}
    </ResourceListFrame>
  );
}

/** One flat list (the environment page). */
export function FlatList<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  minWidth,
}: {
  columns: ResourceListColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  minWidth?: CSSProperties["minWidth"];
}) {
  return (
    <ResourceListFrame minWidth={minWidth ?? resourceListMinWidth(columns)} className="border-0">
      <ResourceListHeaderTable columns={columns} />
      <ResourceListTable columns={columns}>
        {rows.map((row) => (
          <ResourceListRow
            key={rowKey(row)}
            interactive={Boolean(onRowClick)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className="last:border-b-0"
          >
            {columns.map((column) => (
              <ResourceListCell
                key={column.id}
                align={column.align}
                className={column.cellClassName}
                contentClassName={column.cellContentClassName}
              >
                {column.renderCell?.(row)}
              </ResourceListCell>
            ))}
          </ResourceListRow>
        ))}
      </ResourceListTable>
    </ResourceListFrame>
  );
}

/** Environments the list groups by, Production first, then the API order. */
export function orderedEnvironments<T extends { isProduction: boolean }>(
  environments: readonly T[]
): T[] {
  return [...environments].sort((a, b) => Number(b.isProduction) - Number(a.isProduction));
}

export function groupByEnvironment<T>(
  environments: AppEnvironmentDetail[],
  rows: T[],
  environmentOf: (row: T) => string | null | undefined
): EnvGroup<T>[] {
  return orderedEnvironments(environments).map((env) => ({
    env,
    rows: rows.filter((row) => environmentOf(row) === env.id),
  }));
}

/** Member types the user's scopes do not show, named inline so the empty space is explained. */
const HIDDEN_SCOPE_TYPES: Record<string, AppMemberType[]> = {
  "docker:containers:view": ["container", "deployment"],
  "docker:compose:view": ["compose"],
  "pages:view": ["pages"],
  "proxy:view": ["route"],
  "domains:view": ["domain"],
  "ssl:cert:view": ["certificate"],
  "logs:environments:view": ["logging"],
};

/**
 * The hidden-member entries of types the app really has out of the user's sight (the API names those types per
 * environment it shows with apps:view; an environment seen only through members names none).
 */
export function presentHiddenMembers<T extends { scope: string }>(
  app: AppDetail,
  hidden: T[]
): T[] {
  const types = new Set(app.environments.flatMap((env) => env.hiddenMemberTypes ?? []));
  return hidden.filter((entry) =>
    (HIDDEN_SCOPE_TYPES[entry.scope] ?? []).some((type) => types.has(type))
  );
}

export function HiddenMembersNotice({ hidden }: { hidden: { title: string; scope: string }[] }) {
  if (hidden.length === 0) return null;
  return (
    <Notice tone="info" title="Some members are not shown">
      {hidden.map((entry) => `${entry.title} need ${entry.scope}`).join(" · ")}.
    </Notice>
  );
}
