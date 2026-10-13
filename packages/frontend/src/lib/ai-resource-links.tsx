import type { AnchorHTMLAttributes, MouseEvent } from "react";
import type { Components } from "react-markdown";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useUIStore } from "@/stores/ui";
import type { AIResourceReference } from "@/types/ai";
import { getNodeAppearanceColor } from "./node-appearance";
import { aiResourceHref, resourceTypeIcon, resourceTypeLabel } from "./resource-presentation";
import { createReturnNavigationState } from "./return-navigation";

const MARKER_RE = /\[\[resource:(gwr_[a-f0-9]{24})\|((?:[^[\]\r\n]|\[[^[\]\r\n]*\]){1,240})\]\]/g;
const INTERNAL_HREF_PREFIX = "#opfield-resource:";

/** Whether a Markdown link target is a resource link that renders as a chip. */
export function isResourceMarkdownHref(href: unknown): boolean {
  return typeof href === "string" && href.startsWith(INTERNAL_HREF_PREFIX);
}

export function resourceAwareMarkdown(content: string, references: AIResourceReference[]): string {
  const referencesById = new Map(references.map((reference) => [reference.refId, reference]));
  return content.replace(MARKER_RE, (_marker, refId: string, fallbackLabel: string) => {
    const reference = referencesById.get(refId);
    const label = escapeMarkdownLabel(reference?.label ?? fallbackLabel.trim());
    return reference ? `[${label}](${INTERNAL_HREF_PREFIX}${refId})` : label;
  });
}

export function resourceMarkdownLinkComponent(references: AIResourceReference[]): Components["a"] {
  const referencesById = new Map(references.map((reference) => [reference.refId, reference]));
  return ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => {
    if (href?.startsWith(INTERNAL_HREF_PREFIX)) {
      const reference = referencesById.get(href.slice(INTERNAL_HREF_PREFIX.length));
      if (reference) return <AIResourceLink reference={reference} />;
      return <>{children}</>;
    }
    return (
      <a
        className="text-primary underline"
        target="_blank"
        rel="noopener noreferrer"
        href={href}
        {...props}
      >
        {children}
      </a>
    );
  };
}

export function AIResourceLink({ reference }: { reference: AIResourceReference }) {
  const location = useLocation();
  const navigate = useNavigate();
  const aiWorkspace = useUIStore((state) => state.aiLiteMode);
  const setAILiteMode = useUIStore((state) => state.setAILiteMode);
  const setAIPanelOpen = useUIStore((state) => state.setAIPanelOpen);
  const Icon = resourceTypeIcon(reference.type);
  const typeLabel = resourceTypeLabel(reference.type);
  const displayLabel =
    reference.type === "proxy_host"
      ? (reference.label.split(",")[0]?.trim() ?? reference.label)
      : reference.label;
  const appearance = getNodeAppearanceColor(reference.appearanceColor);
  const toneClassName =
    appearance?.badgeClassName ??
    "bg-[color:color-mix(in_srgb,var(--color-link)_12%,transparent)] text-[color:var(--color-link)]";
  const derivedHref = aiResourceHref(reference);
  const href = reference.type === "proxy_host" ? derivedHref : (reference.uiHref ?? derivedHref);
  const openOperationsConsole = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setAILiteMode(false);
    setAIPanelOpen(true);
    navigate(href);
  };
  const openPrimary = (event: MouseEvent<HTMLAnchorElement>) => {
    if (aiWorkspace && reference.workspaceEmbeddable === false) openOperationsConsole(event);
  };
  return (
    <Link
      to={href}
      state={createReturnNavigationState(location)}
      onClick={openPrimary}
      className={`mx-0.5 inline box-decoration-clone rounded-sm px-1 py-0.5 align-baseline font-medium no-underline transition-colors [overflow-wrap:anywhere] hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${toneClassName} ${reference.relation === "deleted" ? "opacity-70" : ""}`}
      aria-label={`${typeLabel}: ${displayLabel}`}
    >
      <Icon className="mr-1 inline-block h-3 w-3 align-[-0.08em]" aria-hidden="true" />
      {displayLabel}
    </Link>
  );
}

export function AIChangedResources({ references }: { references: AIResourceReference[] }) {
  if (references.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col items-start gap-1.5 text-sm text-muted-foreground">
      <span>Modified resources</span>
      <div className="flex flex-wrap items-center gap-1">
        {references.map((reference) => (
          <AIResourceLink key={reference.refId} reference={reference} />
        ))}
      </div>
    </div>
  );
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}
