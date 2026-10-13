---
{
  "id": "fgmxlp0p",
  "file_name": "fgmxlp0p_metadata_only_payloads",
  "tags": [
    "ai-chat",
    "conversation-retrieval",
    "opfield",
    "security",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1783279658914,
  "updated_at": 1791851541229
}
---
In the Opfield repository, AI conversation retrieval (`search_chats`, `find_in_chat`, `read_chat_slice`, prompt tail context) must not index or return raw tool arguments/results/content under only `feat:ai:use`. Normal user/assistant text remains searchable/readable, but tool call/result surfaces should be metadata-only: tool name/id/status, not `toolArgs`, `result`, `toolArgsCompact`, `toolResultRaw`, `toolResultCompact`, or role=`tool` message content. When changing this area, include tests for persisted index rebuild, in-memory find_in_chat, read_chat_slice, prompt tail context, and migration behavior. The cleanup migration should selectively purge unsafe derived search docs (`tool_call`, `tool_result`, `window`, role=`tool`) rather than deleting the entire search index, so older normal chat search remains usable.
