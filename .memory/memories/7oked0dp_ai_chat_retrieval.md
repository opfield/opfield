---
{
  "id": "7oked0dp",
  "file_name": "7oked0dp_ai_chat_retrieval",
  "tags": [
    "ai-chat",
    "drizzle",
    "opfield",
    "search",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1782520378979,
  "updated_at": 1791851267652
}
---
In the Opfield repository, AI chat retrieval tools must not make read paths depend on rebuilding ai_conversation_search_documents. `find_in_chat` should search bounded raw conversation rows in memory, while global `search_chats` can use the persisted search index. Search index rebuild inserts should be batched (currently 100 documents per insert) to avoid huge Drizzle/Postgres statements. Useful verification after changes: `rtk pnpm --filter backend lint`, `rtk pnpm --filter backend exec tsc --noEmit`, `rtk pnpm --filter backend exec vitest run src/modules/ai`, and `rtk git diff --check`.
