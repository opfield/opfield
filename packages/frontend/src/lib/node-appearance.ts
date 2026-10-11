import { isGatewayVersionNewer } from "@/lib/gateway-update-reload";
import { cn } from "@/lib/utils";
import type { NodeAppearanceColor, NodeType } from "@/types";

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  nginx: "Ingress",
  docker: "Docker",
  builder: "Build Worker",
  databases: "Storage",
  storage: "Storage",
  monitoring: "Monitoring",
  bastion: "Bastion",
  relay: "Relay",
};

export function nodeTypeLabel(type: NodeType | string): string {
  return NODE_TYPE_LABELS[type as NodeType] ?? type;
}

export function daemonTypeForNode(type: NodeType | string): string {
  return type === "databases" || type === "storage" || type === "builder" ? "docker" : type;
}

export const NODE_APPEARANCE_COLOR_OPTIONS: Array<{
  value: NodeAppearanceColor;
  label: string;
  badgeClassName: string;
  iconClassName: string;
  iconBackgroundClassName: string;
  swatchClassName: string;
}> = [
  {
    value: "blue",
    label: "Blue",
    badgeClassName: "bg-blue-500/15 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400",
    iconClassName: "text-blue-600 dark:text-blue-400",
    iconBackgroundClassName: "bg-blue-500/15 dark:bg-blue-500/15",
    swatchClassName: "bg-blue-500",
  },
  {
    value: "red",
    label: "Red",
    badgeClassName: "bg-red-500/15 text-red-600 dark:bg-red-500/15 dark:text-red-400",
    iconClassName: "text-red-600 dark:text-red-400",
    iconBackgroundClassName: "bg-red-500/15 dark:bg-red-500/15",
    swatchClassName: "bg-red-500",
  },
  {
    value: "green",
    label: "Green",
    badgeClassName:
      "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
    iconClassName: "text-emerald-600 dark:text-emerald-400",
    iconBackgroundClassName: "bg-emerald-500/15 dark:bg-emerald-500/15",
    swatchClassName: "bg-emerald-500",
  },
  {
    value: "yellow",
    label: "Yellow",
    badgeClassName: "bg-amber-500/15 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
    iconClassName: "text-amber-700 dark:text-amber-400",
    iconBackgroundClassName: "bg-amber-500/15 dark:bg-amber-500/15",
    swatchClassName: "bg-amber-500",
  },
  {
    value: "purple",
    label: "Purple",
    badgeClassName: "bg-violet-500/15 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
    iconClassName: "text-violet-600 dark:text-violet-400",
    iconBackgroundClassName: "bg-violet-500/15 dark:bg-violet-500/15",
    swatchClassName: "bg-violet-500",
  },
  {
    value: "pink",
    label: "Pink",
    badgeClassName: "bg-pink-500/15 text-pink-600 dark:bg-pink-500/15 dark:text-pink-400",
    iconClassName: "text-pink-600 dark:text-pink-400",
    iconBackgroundClassName: "bg-pink-500/15 dark:bg-pink-500/15",
    swatchClassName: "bg-pink-500",
  },
  {
    value: "orange",
    label: "Orange",
    badgeClassName: "bg-orange-500/15 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400",
    iconClassName: "text-orange-600 dark:text-orange-400",
    iconBackgroundClassName: "bg-orange-500/15 dark:bg-orange-500/15",
    swatchClassName: "bg-orange-500",
  },
];

export function getNodeAppearanceColor(color: NodeAppearanceColor | null | undefined) {
  return NODE_APPEARANCE_COLOR_OPTIONS.find((option) => option.value === color) ?? null;
}

export function nodeBadgeClassName(
  color: NodeAppearanceColor | null | undefined,
  className?: string
) {
  const option = getNodeAppearanceColor(color);
  return cn("max-w-full shrink-0", option?.badgeClassName, className);
}

export function nodeIconClassNames(color: NodeAppearanceColor | null | undefined) {
  const option = getNodeAppearanceColor(color);
  return {
    wrapper: cn(
      "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
      option ? option.iconBackgroundClassName : "bg-muted"
    ),
    icon: option?.iconClassName ?? "text-muted-foreground",
  };
}

/**
 * Whether a node's daemon is older than the latest release of its type. Decided from the node's
 * current daemon version, so a daemon-update status fetched before the node updated cannot keep
 * offering the release it already runs.
 */
export function isDaemonUpdateAvailable(
  daemonVersion: string | null | undefined,
  latestVersion: string | null | undefined
): latestVersion is string {
  return !!latestVersion && isGatewayVersionNewer(latestVersion, daemonVersion ?? "");
}
