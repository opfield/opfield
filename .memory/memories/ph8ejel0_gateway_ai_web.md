---
{
  "id": "ph8ejel0",
  "file_name": "ph8ejel0_gateway_ai_web",
  "tags": [
    "ai-service",
    "backend",
    "opfield",
    "refactor",
    "web-search"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.85,
  "created_at": 1781991928525,
  "updated_at": 1791851831156
}
---
Opfield AI web_search contract (implementation in `packages/backend/src/modules/ai/ai.web-search.ts`, extracted from ai.service.ts in June 2026; re-verified 2026-10-01):
- Tavily receives `api_key` in the JSON body together with `search_depth: 'basic'`, not as an Authorization header.
- SearXNG uses `/search?q=...&format=json&pageno=1` without categories and needs no API key, but requires a base URL; a missing base URL or one pointing to a private address returns a tool error.
- Providers other than SearXNG without credentials return the result error 'Web search is not configured. An admin must set up the web search API key.' rather than throwing.
