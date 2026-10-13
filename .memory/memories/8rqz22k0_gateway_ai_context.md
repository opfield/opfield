---
{
  "id": "8rqz22k0",
  "file_name": "8rqz22k0_gateway_ai_context",
  "tags": [
    "ai-chat",
    "context-estimate",
    "opfield",
    "tool-discovery",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.87,
  "created_at": 1782786026080,
  "updated_at": 1791851297880
}
---
In the Opfield repository, AI context accounting should treat a missing conversationId as zero discovered tool categories, not as undefined/no discovery filter. The bug caused new empty chats to expose every scoped OpenAI tool schema and report ~23k tool tokens. Fix pattern: AIService.getConversationDiscoveredToolsets returns [] when there is no conversation; getOpenAITools keeps base tools plus conversation retrieval tools visible in BASE_AI_TOOL_NAMES; /context can report system/tool breakdowns from the backend estimate endpoint. Verification from the fix: all broad scopes with discoveredToolsets=[] produced 11 base tools and ~2215 tool tokens, while unfiltered all tools produced 143 tools and ~22127 tool tokens. Targeted checks passed: backend ai.service-system-prompt tests, frontend ai-conversation-persistence tests, backend build, frontend tsc, biome checks, and git diff --check.
