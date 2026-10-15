import { useLocation } from "react-router-dom";
import { legacyPathForPath } from "@/lib/navigation-hubs";
import { hasScopeBase } from "@/lib/scope-utils";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import type { PageContext, QuickAction } from "@/types/ai";
import { useInferenceQuotaSnapshot } from "./InferenceQuotaStatus";

const QUICK_ACTIONS: Record<string, QuickAction[]> = {
  "/": [
    { label: "System overview", prompt: "Give me an overview of the system status" },
    {
      label: "Expiring soon",
      prompt: "Show certificates expiring in the next 30 days",
      scope: "ssl:cert:view",
    },
    {
      label: "Health summary",
      prompt: "What's the health status of all ingress routes?",
      scope: "proxy:view",
    },
    {
      label: "Recent changes",
      prompt: "Summarize recent operational changes and their impact",
      scope: "admin:audit",
    },
    { label: "What needs attention", prompt: "What needs my attention right now?" },
    {
      label: "Plan an improvement",
      prompt: "Help me plan the most valuable next infrastructure improvement",
    },
  ],
  "/cas": [
    { label: "List all CAs", prompt: "List all Certificate Authorities", scope: "pki:ca:view" },
    {
      label: "Create root CA",
      prompt: "Help me create a new root CA",
      scope: "pki:ca:create:root",
    },
    { label: "CA hierarchy", prompt: "Show me the CA hierarchy tree", scope: "pki:ca:view" },
  ],
  "/certificates": [
    {
      label: "Expiring soon",
      prompt: "Show certificates expiring in the next 30 days",
      scope: "pki:cert:view",
    },
    {
      label: "Issue certificate",
      prompt: "Help me issue a new certificate",
      scope: "pki:cert:issue",
    },
    { label: "Revoked certs", prompt: "List all revoked certificates", scope: "pki:cert:view" },
  ],
  "/proxy-hosts": [
    { label: "List all routes", prompt: "List all ingress routes with their status" },
    { label: "Create route", prompt: "Help me create a new ingress route", scope: "proxy:create" },
    { label: "Unhealthy routes", prompt: "Show ingress routes that are offline or degraded" },
    {
      label: "Traffic errors",
      prompt: "Investigate recent traffic errors and affected ingress routes",
    },
    {
      label: "Secure a route",
      prompt: "Help me secure an ingress route with a domain and certificate",
      scope: "proxy:edit",
    },
  ],
  "/ssl-certificates": [
    { label: "List SSL certs", prompt: "List all SSL certificates with expiry dates" },
    {
      label: "Request ACME cert",
      prompt: "Help me request a new Let's Encrypt certificate",
      scope: "ssl:cert:issue",
    },
    { label: "Expiring SSL", prompt: "Show SSL certificates expiring soon" },
  ],
  "/domains": [
    { label: "DNS status", prompt: "Show the DNS verification status of all domains" },
    { label: "Add domain", prompt: "Help me register a new domain", scope: "domains:create" },
  ],
  "/templates/pki": [
    { label: "List templates", prompt: "Show all certificate templates" },
    {
      label: "Create template",
      prompt: "Help me create a new certificate template",
      scope: "pki:templates:create",
    },
  ],
  "/administration": [
    { label: "List users", prompt: "List all users with their roles", scope: "admin:users" },
    { label: "User activity", prompt: "Show recent audit log activity", scope: "admin:audit" },
    {
      label: "Recent activity",
      prompt: "Show the last 20 audit log entries",
      scope: "admin:audit",
    },
    {
      label: "AI actions",
      prompt: "Show audit log entries from AI Workspace actions",
      scope: "admin:audit",
    },
  ],
  "/settings": [{ label: "System info", prompt: "Show system information and statistics" }],
  "/docker/containers": [
    { label: "List containers", prompt: "List all Docker containers across all nodes" },
    { label: "Container status", prompt: "Show a summary of running and stopped containers" },
    {
      label: "Investigate failures",
      prompt: "Investigate containers that recently failed or restarted",
    },
    {
      label: "Release safely",
      prompt: "Help me plan a safe release for a running container",
      scope: "docker:containers:manage",
    },
  ],
  "/docker/images": [{ label: "List images", prompt: "List all Docker images" }],
  "/docker/volumes": [{ label: "List volumes", prompt: "List all Docker volumes" }],
  "/docker/networks": [{ label: "List networks", prompt: "List all Docker networks" }],
};

const DEFAULT_ACTIONS: QuickAction[] = [
  { label: "System overview", prompt: "Give me an overview of the system" },
  { label: "Help", prompt: "What can you help me with?" },
];

interface QuickActionChipsProps {
  onSelect: (prompt: string) => void;
  context?: PageContext;
}

export function QuickActionChips({ onSelect, context }: QuickActionChipsProps) {
  const location = useLocation();
  const opfieldInferenceMode = useAIStore(
    (state) => state.providerStatus?.providerType === "opfield_inference"
  );
  const canViewInferenceUsage = useAuthStore((state) => state.hasScope("feat:ai:use"));
  const scopes = useAuthStore((state) => state.user?.scopes);
  const inferenceQuota = useInferenceQuotaSnapshot(opfieldInferenceMode && canViewInferenceUsage);

  // Keys are the page URLs from before Routes and Certificates had tabs.
  const pathname = legacyPathForPath(location.pathname);
  const routeActions =
    QUICK_ACTIONS[pathname] || QUICK_ACTIONS[pathname.replace(/\/[^/]+$/, "")] || DEFAULT_ACTIONS;
  const resourceActions: QuickAction[] = context?.label
    ? [
        {
          label: `Inspect ${context.label}`,
          prompt: `Inspect ${context.label} and explain its current state, risks, and next useful action`,
        },
        {
          label: "Investigate this resource",
          prompt: `Investigate any operational issues for ${context.label} and show the evidence`,
        },
      ]
    : [];
  // A chip whose request needs a grant the user lacks would only be refused.
  const actions = [
    ...resourceActions,
    ...routeActions.filter((action) => !action.scope || hasScopeBase(scopes ?? [], action.scope)),
  ].slice(0, 6);

  return (
    <div className="flex flex-wrap justify-center gap-1.5 px-3 py-3">
      {/* Prompt chips: bordered, wrapping pills rather than kit buttons. */}
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => onSelect(action.prompt)}
          disabled={inferenceQuota.exhausted}
          className="border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
