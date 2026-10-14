// Where the scopes of one scope-list section reach: "Everywhere", one place ("Shop · production")
// or "N places" in the section header, and a picker of only the places that hold that kind (its
// folders, the apps and environments with members of that kind). Rows follow the section unless
// "Only this scope…" gives one of them its own restriction.
import { AppWindow, ChevronDown, Folder, Layers } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ScopeSearchFilter } from "@/components/common/ScopeSearchFilter";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AppMemberFamily } from "@/types/apps";
import {
  APP_FAMILY_FOLDER_FAMILY,
  type AppScopeApp,
  appPlaceLabel,
  type FolderFamily,
  type FolderOption,
  folderTarget,
  isFolderTarget,
} from "./scope-list-helpers";

export const FOLDER_FAMILY_LABELS: Record<FolderFamily, string> = {
  groups: "Permission groups",
  users: "Users",
  domains: "Domains",
  proxy: "Routes",
  nodes: "Nodes",
  docker: "Docker containers",
  "docker-network": "Docker networks",
  "docker-volume": "Docker volumes",
  "docker-image": "Docker images",
  "docker-compose": "Compose projects",
  pages: "Pages",
  ssl: "SSL certificates",
  "pki-cas": "Certificate authorities",
  "pki-certificates": "PKI certificates",
  "nginx-templates": "Nginx templates",
  databases: "Databases",
  storage: "Storage",
  "logging-environments": "Logging environments",
  "logging-schemas": "Logging schemas",
  apps: "Apps",
};

const APP_MEMBER_NOUNS: Record<AppMemberFamily, [string, string]> = {
  containers: ["container", "containers"],
  compose: ["Compose project", "Compose projects"],
  routes: ["route", "routes"],
  databases: ["database", "databases"],
  storage: ["storage", "storage"],
  pages: ["Pages project", "Pages projects"],
  certificates: ["SSL certificate", "SSL certificates"],
  logging: ["logging environment", "logging environments"],
  domains: ["domain", "domains"],
};

/** Places chosen for a section, per folder family of its scopes. Empty or absent: everywhere. */
export type SectionLimit = Partial<Record<FolderFamily, string[]>>;

export interface SectionPlace {
  /** The restriction target (`folder/<id>`). */
  target: string;
  family: FolderFamily;
  label: string;
  type: "folder" | "app" | "environment";
  detail?: string;
  /** Targets that already cover this place (parent folders, the app of an environment). */
  coveredBy: string[];
}

function appMemberFamily(family: FolderFamily): AppMemberFamily | null {
  const entry = (
    Object.entries(APP_FAMILY_FOLDER_FAMILY) as [AppMemberFamily, FolderFamily][]
  ).find(([, folderFamily]) => folderFamily === family);
  return entry ? entry[0] : null;
}

export function sameTargets(a: readonly string[], b: readonly string[]) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Whether a restriction names folders only, so it can be a section's place limit. */
export function isPlaceRestriction(targets: readonly string[]) {
  return targets.every(isFolderTarget);
}

/**
 * The places a section of the given folder families can be limited to: the folders of each
 * family, then the apps and environments that hold members of that family. Places the
 * signed-in user cannot grant (`allowed` narrows a family) are left out unless already chosen.
 */
export function sectionPlaces({
  families,
  folders,
  apps,
  chosen,
  allowed,
}: {
  families: readonly FolderFamily[];
  folders: readonly FolderOption[];
  apps: readonly AppScopeApp[];
  chosen: SectionLimit;
  allowed: Partial<Record<FolderFamily, readonly string[]>>;
}): SectionPlace[] {
  return families.flatMap((family) => {
    const chosenTargets = new Set(chosen[family] ?? []);
    const places: SectionPlace[] = [];
    const memberFamily = appMemberFamily(family);
    if (memberFamily) {
      for (const app of apps) {
        const rootId = app.rootFolderIds?.[memberFamily];
        const rootTarget = rootId ? folderTarget(rootId) : null;
        const environments = app.environments.flatMap((environment) => {
          const id = environment.folderIds[memberFamily];
          if (!id) return [];
          const count = environment.memberCounts[memberFamily] ?? 0;
          const target = folderTarget(id);
          if (count === 0 && !chosenTargets.has(target)) return [];
          const [one, many] = APP_MEMBER_NOUNS[memberFamily];
          return [
            {
              target,
              family,
              label: appPlaceLabel(app, environment),
              type: "environment" as const,
              detail: `${count} ${count === 1 ? one : many}`,
              coveredBy: rootTarget ? [rootTarget] : [],
            },
          ];
        });
        if (rootTarget && (environments.length > 0 || chosenTargets.has(rootTarget))) {
          places.push({
            target: rootTarget,
            family,
            label: appPlaceLabel(app),
            type: "app",
            detail: "Every environment, also new ones",
            coveredBy: [],
          });
        }
        places.push(...environments);
      }
    }
    for (const folder of folders) {
      if (folder.family !== family || folder.appEnvironment) continue;
      places.push({
        target: folderTarget(folder.id),
        family,
        label: folder.label,
        type: "folder",
        coveredBy: folder.ancestorIds.map(folderTarget),
      });
    }
    const allowedTargets = allowed[family];
    if (!allowedTargets) return places;
    return places.filter(
      (place) =>
        chosenTargets.has(place.target) ||
        allowedTargets.includes(place.target) ||
        place.coveredBy.some((target) => allowedTargets.includes(target))
    );
  });
}

/**
 * A section's places of one family, read back from its selected scopes' own places (each
 * scope's restriction; restrictions naming single resources do not count). When they all agree,
 * that is the section's choice. When they differ, the section reaches where its scopes reach
 * together: everywhere if one of them does, otherwise every place any of them names; `mixed`
 * marks that the rows do not share one choice.
 */
export function deriveFamilyLimit(restrictions: readonly (readonly string[])[]): {
  targets: string[];
  mixed: boolean;
} {
  const places = restrictions.filter(isPlaceRestriction);
  const first = places[0];
  if (!first) return { targets: [], mixed: false };
  if (places.every((targets) => sameTargets(targets, first))) {
    return { targets: [...first], mixed: false };
  }
  if (places.some((targets) => targets.length === 0)) return { targets: [], mixed: true };
  return { targets: [...new Set(places.flat())], mixed: true };
}

/** "Everywhere", the one place, or "N places". */
export function whereLabel(targets: readonly string[], labelOf: (target: string) => string) {
  if (targets.length === 0) return "Everywhere";
  if (targets.length === 1) return labelOf(targets[0] as string);
  return `${targets.length} places`;
}

function PlaceIcon({ type }: { type: SectionPlace["type"] }) {
  const Icon = type === "folder" ? Folder : type === "app" ? AppWindow : Layers;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

/** One plain row of the picker: checkbox, icon, name, and the detail muted at the end. */
function PlaceRow({
  checked,
  disabled,
  onCheckedChange,
  icon,
  label,
  detail,
}: {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  icon?: ReactNode;
  label: string;
  detail?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 px-3 py-1.5 transition-colors hover:bg-accent/50 has-[:disabled]:cursor-default has-[:disabled]:hover:bg-transparent">
      <span className="flex h-5 shrink-0 items-center">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onCheckedChange(event.target.checked)}
        />
      </span>
      {icon ? <span className="flex h-5 shrink-0 items-center">{icon}</span> : null}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
        {detail ? <span className="shrink-0 text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </label>
  );
}

/** The section header's place link and its picker. */
export function SectionPlacesPicker({
  sectionLabel,
  where,
  families,
  places,
  chosen,
  everywhereAllowed,
  followers,
  exceptions,
  loading,
  onOpen,
  onChange,
}: {
  sectionLabel: string;
  where: string;
  families: readonly FolderFamily[];
  places: readonly SectionPlace[];
  chosen: SectionLimit;
  /** False when the signed-in user may grant these scopes in some places only. */
  everywhereAllowed: boolean;
  /** Selected scopes of the section that follow its places. */
  followers: number;
  /** Selected scopes of the section with a restriction of their own. */
  exceptions: number;
  loading: boolean;
  onOpen: () => void;
  onChange: (next: SectionLimit) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const everywhere = families.every((family) => (chosen[family]?.length ?? 0) === 0);
  const visible = q ? places.filter((place) => place.label.toLowerCase().includes(q)) : places;

  const toggle = (place: SectionPlace) => {
    const current = chosen[place.family] ?? [];
    const next = current.includes(place.target)
      ? current.filter((target) => target !== place.target)
      : [
          // A place covers what lies inside it: an app its environments, a folder its subfolders.
          ...current.filter(
            (target) =>
              !places.some(
                (other) => other.target === target && other.coveredBy.includes(place.target)
              )
          ),
          place.target,
        ];
    onChange({ ...chosen, [place.family]: next });
  };

  const groups = families.flatMap((family) => {
    const prefix = families.length > 1 ? `${FOLDER_FAMILY_LABELS[family]} · ` : "";
    const ofFamily = visible.filter((place) => place.family === family);
    const appPlaces = ofFamily.filter((place) => place.type !== "folder");
    const folderPlaces = ofFamily.filter((place) => place.type === "folder");
    return [
      ...(appPlaces.length > 0
        ? [{ key: `${family}:apps`, label: `${prefix}Apps`, places: appPlaces }]
        : []),
      ...(folderPlaces.length > 0
        ? [{ key: `${family}:folders`, label: `${prefix}Folders`, places: folderPlaces }]
        : []),
    ];
  });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen();
        else setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="link"
          size="inline"
          className="min-w-0 text-xs"
          aria-label={`Where ${sectionLabel} scopes reach: ${where}`}
        >
          <span className="truncate">{where}</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <ScopeSearchFilter
          search={search}
          onSearchChange={setSearch}
          placeholder="Search folders and apps..."
        />
        <div className="max-h-80 overflow-y-auto overscroll-contain py-1">
          {!q && (
            <PlaceRow
              checked={everywhere}
              disabled={!everywhereAllowed}
              onCheckedChange={(checked) => {
                if (!checked || everywhere) return;
                onChange(Object.fromEntries(families.map((family) => [family, []])));
              }}
              label="Everywhere"
            />
          )}
          {groups.map((group) => (
            <div key={group.key} className="pt-2">
              <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
              {group.places.map((place) => {
                const covered = place.coveredBy.some((target) =>
                  (chosen[place.family] ?? []).includes(target)
                );
                return (
                  <PlaceRow
                    key={`${place.family}:${place.target}`}
                    checked={covered || (chosen[place.family] ?? []).includes(place.target)}
                    disabled={covered}
                    onCheckedChange={() => toggle(place)}
                    icon={<PlaceIcon type={place.type} />}
                    label={place.label}
                    detail={place.detail}
                  />
                );
              })}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {loading
                ? "Loading folders and apps…"
                : q
                  ? `Nothing matches “${search.trim()}”.`
                  : "No folders or apps hold these resources yet."}
            </p>
          )}
        </div>
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {followers === 0
            ? "Applies to the scopes you select in this section"
            : `Applies to the ${followers} selected scope${followers === 1 ? "" : "s"} of this section`}
          {exceptions > 0 ? ` · ${exceptions} set separately` : ""}
        </p>
      </PopoverContent>
    </Popover>
  );
}
