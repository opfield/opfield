import { HttpResponse, http } from "msw";
import type { AIConversationSummary } from "@/services/ai-conversations";
import type { AIContextEstimate, AIMessage, AIResourceReference } from "@/types/ai";
import { containers, databases, routes } from "../catalog";
import { nodeBySlug } from "../nodes";
import { aiStatus } from "../shell";
import { ago, uuid } from "../time";

const apps2 = nodeBySlug("apps-2")!;
const grafanaRoute = routes.find((route) => route.slug === "grafana")!;
const grafanaContainer = containers.find((container) => container.name === "grafana")!;
const analytics = databases.find((database) => database.slug === "analytics")!;

export const AI_CONVERSATION_ID = uuid(41501);

type Color = AIResourceReference["appearanceColor"];

/** Resources the assistant read while answering; rendered as inline resource chips. */
const refs = {
  route: {
    refId: "gwr_4f1c0a9e22b7d4e1a0c3b5d7",
    type: "proxy_host",
    resourceId: grafanaRoute.id,
    label: grafanaRoute.domains[0],
    slug: grafanaRoute.slug,
    relation: "read",
  },
  container: {
    refId: "gwr_7b22d91c0a44e8f1c2d3a4b5",
    type: "docker_container",
    resourceId: grafanaContainer.id,
    label: grafanaContainer.name,
    nodeId: apps2.id,
    nodeSlug: apps2.slug,
    appearanceColor: apps2.appearanceColor as Color,
    relation: "read",
  },
  node: {
    refId: "gwr_a1b2c3d4e5f60718293a4b5c",
    type: "node",
    resourceId: apps2.id,
    label: apps2.displayName ?? apps2.hostname,
    slug: apps2.slug,
    appearanceColor: apps2.appearanceColor as Color,
    relation: "read",
  },
  database: {
    refId: "gwr_0d9e8f7a6b5c4d3e2f1a0b9c",
    type: "database",
    resourceId: analytics.id,
    label: analytics.name,
    slug: analytics.slug,
    relation: "read",
  },
  certificate: {
    refId: "gwr_5e6f7a8b9c0d1e2f3a4b5c6d",
    type: "ssl_certificate",
    resourceId: uuid(8001),
    label: "grafana.example.com",
    relation: "read",
  },
} satisfies Record<string, AIResourceReference>;

const ref = (reference: AIResourceReference, label = reference.label) =>
  `[[resource:${reference.refId}|${label}]]`;

const runId = uuid(41502);

export const aiMessages: AIMessage[] = [
  {
    id: uuid(41511),
    role: "user",
    content: "Why is grafana.example.com showing as degraded?",
    sequence: 1,
    createdAt: ago(7, "m"),
  },
  {
    id: uuid(41512),
    role: "assistant",
    content: "Checking the route's health checks and the container behind it.",
    sequence: 2,
    runId,
    createdAt: ago(7, "m"),
  },
  {
    id: uuid(41513),
    role: "assistant",
    content: "",
    sequence: 3,
    runId,
    createdAt: ago(6, "m"),
    toolCalls: [
      {
        id: uuid(41521),
        runId,
        name: "get_route",
        arguments: { id: grafanaRoute.slug },
        status: "completed",
        result: { healthStatus: "degraded", slowThresholdMs: 800, lastResponseMs: 1740 },
      },
      {
        id: uuid(41522),
        runId,
        name: "get_docker_container_stats",
        arguments: { nodeId: apps2.slug, containerId: grafanaContainer.name },
        status: "completed",
        result: { memoryUsage: "1.46 GiB", memoryLimit: "1.5 GiB", cpuPercent: 94.2 },
      },
      {
        id: uuid(41523),
        runId,
        name: "get_docker_container_logs",
        arguments: { nodeId: apps2.slug, containerId: grafanaContainer.name, tail: 200 },
        status: "completed",
        result: "… 58 lines matched \"context deadline exceeded\"",
      },
    ],
  },
  {
    id: uuid(41514),
    role: "assistant",
    sequence: 4,
    runId,
    createdAt: ago(6, "m"),
    resourceReferences: Object.values(refs),
    content: [
      `${ref(refs.route)} is up, but slow. Its health check has answered in 1.2–1.9 s for the last 40 minutes, above the route's 800 ms slow threshold, so Opfield marks it **degraded** rather than offline.`,
      "",
      "What I found:",
      "",
      `- The ${ref(refs.container)} container on ${ref(refs.node)} is running, but uses **1.46 GiB of its 1.5 GiB** memory limit and ~94% CPU.`,
      `- Its logs show repeated \`context deadline exceeded\` errors from the ${ref(refs.database)} data source since 09:40.`,
      "- Edge Frankfurt itself is healthy; the other routes it serves respond normally.",
      "",
      `Separately, the SSL certificate ${ref(refs.certificate)} expires in 8 days: its last automatic renewal failed because the challenge request got a 502 from the same slow upstream.`,
      "",
      "Suggested fix: raise the container's memory limit to 2 GiB and restart it, then retry the certificate renewal. Want me to do that?",
    ].join("\n"),
  },
];

export const aiConversation: AIConversationSummary = {
  id: AI_CONVERSATION_ID,
  title: "Grafana degraded on Edge Frankfurt",
  createdAt: ago(7, "m"),
  updatedAt: ago(6, "m"),
  lastUserMessageAt: ago(7, "m"),
  folderId: null,
  messageCount: aiMessages.length,
  status: "active",
  blockReason: null,
  activeRunStatus: null,
  planStatus: null,
};

export const earlierConversations: AIConversationSummary[] = [
  {
    ...aiConversation,
    id: uuid(41531),
    title: "Rotate orders-db credentials",
    createdAt: ago(1, "d"),
    updatedAt: ago(1, "d"),
    lastUserMessageAt: ago(1, "d"),
    messageCount: 14,
  },
  {
    ...aiConversation,
    id: uuid(41532),
    title: "Deploy api 2.8.1 to apps-1",
    createdAt: ago(3, "d"),
    updatedAt: ago(3, "d"),
    lastUserMessageAt: ago(3, "d"),
    messageCount: 9,
  },
];

/** Server-side token estimate behind the composer's context ring. */
const contextEstimate: AIContextEstimate = {
  chatTokens: 2_140,
  messageCount: aiMessages.length,
  systemTokens: 6_820,
  toolsTokens: 18_450,
  totalOverhead: 25_270,
  limit: 200_000,
  reasoningEffort: "medium",
  toolCount: 142,
  systemBreakdown: [
    { label: "Base instructions", chars: 14_200, tokens: 3_550 },
    { label: "Page context", chars: 2_300, tokens: 575 },
    { label: "Permissions", chars: 10_780, tokens: 2_695 },
  ],
  toolBreakdown: [
    { label: "Routes & domains", chars: 21_400, tokens: 5_350 },
    { label: "Docker", chars: 26_800, tokens: 6_700 },
    { label: "Nodes & monitoring", chars: 12_400, tokens: 3_100 },
    { label: "Other", chars: 13_200, tokens: 3_300 },
  ],
};

/** The AI settings the composer reads for its context limit. */
const aiConfig = {
  enabled: true,
  providerType: "opfield_inference",
  model: aiStatus.defaultModel,
  maxContextTokens: 200_000,
  reasoningEffort: "medium",
  maxToolRounds: 24,
};

/** Provider status, AI settings and context estimate; the socket itself is mocked out in setup.ts. */
export function aiPanelHandlers() {
  return [
    http.get("*/api/ai/status", () => HttpResponse.json(aiStatus)),
    http.get("*/api/ai/config", () => HttpResponse.json({ data: aiConfig })),
    http.post("*/api/ai/context-estimate", () => HttpResponse.json({ data: contextEstimate })),
  ];
}
