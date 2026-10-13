---
{
  "id": "axhme4ti",
  "file_name": "axhme4ti_ai_chat_errors",
  "tags": [
    "ai-chat",
    "errors",
    "inference",
    "opfield",
    "responses-api",
    "retry"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785446256923,
  "updated_at": 1791851398669
}
---
Opfield AI chat run failures are persisted as localOnly assistant messages prefixed with **Error:**. Render them as left-aligned assistant error blocks. Retry must target the nearest preceding user message, call the existing rollback-to-message endpoint (which deletes that user turn and everything after it), then resend the returned content and attachments using the preserved conversation context. Opfield Inference provider HTTP failures must read only common structured error fields, redact credential-shaped values, bound the displayed reason, map quota failures to a clear quota-exhausted message, and avoid reducing all upstream 400 responses to a generic HTTP status. For OpenAI Responses tool continuation, function-call item `id` and `call_id` are different namespaces: `call_...` belongs only in `call_id`; forward an item `id` only when it is a provider-valid function item id beginning with `fc`. If the internal Assistant retained only the call id, omit the item id instead of replaying `call_...` as `id`, which OpenAI rejects.
