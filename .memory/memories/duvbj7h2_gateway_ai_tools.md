---
{
  "id": "duvbj7h2",
  "file_name": "duvbj7h2_gateway_ai_tools",
  "tags": [
    "ai-tools",
    "opfield",
    "refactor",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.85,
  "created_at": 1781993057004,
  "updated_at": 1791851492838
}
---
Opfield AI tool registry layout: `packages/backend/src/modules/ai/ai.tools.ts` assembles `AI_TOOLS` from category files that each export an `AIToolDefinition[]` array (`ai.tools.control.ts`, `ai.tools.databases.ts`, `ai.tools.discovery.ts`, `ai.tools.docker.ts`, `ai.tools.folders.ts`, `ai.tools.gitlab.ts`, `ai.tools.hosting.ts`, `ai.tools.inference.ts`, `ai.tools.ingress*.ts`, `ai.tools.pki.ts`, `ai.backup-tools.ts`, `ai.storage-tools.ts`, and others). Put new tools into the matching category file instead of growing ai.tools.ts. When moving or adding tools, keep tool names, scope visibility, destructive flags and web-search gating unchanged unless intended, and keep MCP eligibility filtering central (see the MCP tool exposure memory). Never put an apostrophe inside a single-quoted tool description: `biome check --write` on a file that does not parse mangles everything after the error. Verified 2026-10-01; the June 2026 contract tests for the split were removed by the light-suite cut, so verify with backend typecheck, lint and build.
