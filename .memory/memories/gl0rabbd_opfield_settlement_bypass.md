---
{
  "id": "gl0rabbd",
  "file_name": "gl0rabbd_opfield_settlement_bypass",
  "tags": [
    "accounting",
    "inference",
    "inference-core"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1792019181279,
  "updated_at": 1792019181279
}
---
Inference accounting gotcha (found 2026-10-15 on the stand): Chat Completions through any `openai-chat` provider with API-key/local auth (manual openai-compatible, Opfield Cloud, other chat templates) take the inference core's native path (`handleNativeChatCompletions`, src/server/chat-native.ts), which never calls `wiolett.admitAttempt`, so the core sends no admission and no settlement. Opfield then recorded such requests as completed with 0 tokens / $0 and did not enforce per-user budgets. The core also returns non-stream bodies verbatim (upstream `model`), stamps its internal id `core-<connectionId>/<model>` on chat stream chunks (ignores the signed context's `publicModelId`), and its Responses translation carries the upstream model id.

Fix in Opfield (feat/cloud-addons): `inference-core-edge-chat.ts` admits before dispatch and settles from the relayed usage for those requests (deny → 429 budget_exhausted); if the core admits itself the Opfield attempt is dropped (`dropUnsettledAttempt`); `inference-core-model-rewrite.ts` / `inference-core-chat-usage.ts` put the published model id in every relayed body and capture chat usage; `inference-core-sse-observer.ts` ends each format on its own terminal signal (Chat `[DONE]`, Messages `message_stop`) — before, every normal Chat stream was treated as broken and got an extra response.failed event.

**How to apply:** proper fix belongs in the core (call admitAttempt in handleNativeChatCompletions, honour publicModelId); when the core is fixed, the Opfield edge admission must keep yielding to the core's own attempt. When testing inference accounting, check attempt rows per request format (chat vs messages vs responses), not just the request row.
