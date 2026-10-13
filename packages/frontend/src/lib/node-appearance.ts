import { isOpfieldVersionNewer } from "@/lib/opfield-update-reload";
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
    badgeClassName: "bg-swatch-blue/15 text-tone-blue",
    iconClassName: "text-tone-blue",
    iconBackgroundClassName: "bg-swatch-blue/15",
    swatchClassName: "bg-swatch-blue",
  },
  {
    value: "red",
    label: "Red",
    badgeClassName: "bg-swatch-red/15 text-tone-red",
    iconClassName: "text-tone-red",
    iconBackgroundClassName: "bg-swatch-red/15",
    swatchClassName: "bg-swatch-red",
  },
  {
    value: "green",
    label: "Green",
    badgeClassName: "bg-swatch-green/15 text-tone-green",
    iconClassName: "text-tone-green",
    iconBackgroundClassName: "bg-swatch-green/15",
    swatchClassName: "bg-swatch-green",
  },
  {
    value: "yellow",
    label: "Yellow",
    badgeClassName: "bg-swatch-yellow/15 text-tone-yellow",
    iconClassName: "text-tone-yellow",
    iconBackgroundClassName: "bg-swatch-yellow/15",
    swatchClassName: "bg-swatch-yellow",
  },
  {
    value: "purple",
    label: "Purple",
    badgeClassName: "bg-swatch-purple/15 text-tone-purple",
    iconClassName: "text-tone-purple",
    iconBackgroundClassName: "bg-swatch-purple/15",
    swatchClassName: "bg-swatch-purple",
  },
  {
    value: "pink",
    label: "Pink",
    badgeClassName: "bg-swatch-pink/15 text-tone-pink",
    iconClassName: "text-tone-pink",
    iconBackgroundClassName: "bg-swatch-pink/15",
    swatchClassName: "bg-swatch-pink",
  },
  {
    value: "orange",
    label: "Orange",
    badgeClassName: "bg-swatch-orange/15 text-tone-orange",
    iconClassName: "text-tone-orange",
    iconBackgroundClassName: "bg-swatch-orange/15",
    swatchClassName: "bg-swatch-orange",
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
      "flex h-10 w-10 shrink-0 items-center justify-center",
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
  return !!latestVersion && isOpfieldVersionNewer(latestVersion, daemonVersion ?? "");
}
