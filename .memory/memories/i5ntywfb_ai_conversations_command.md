---
{
  "id": "i5ntywfb",
  "file_name": "i5ntywfb_ai_conversations_command",
  "tags": [
    "ai-conversations",
    "command-palette",
    "frontend",
    "gateway-inference",
    "quota"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.84,
  "created_at": 1785448712405,
  "updated_at": 1791851648092
}
---
Opfield frontend details for inference usage cards, the Command Palette and AI conversation titles:

- Superseded (2026-09): the July 2026 rule that derived a rolling-window `recoveryAt` from `inference_usage_ledger.occurred_at` no longer applies. Subscription limits are now fixed, lazily started 5-hour/7-day/30-day windows (see the inference product contract memory); recovery time is the end of the active window.
- Self-usage cards show an exact future recovery date. Do not use the past-only `formatRelativeDate` for future dates (it labels every future date "Just now"). Keep the existing card label/value scale; only the recovery subtitle is 12px instead of 10px.
- Command Palette search state clears when the dialog content's closing animation completes, not immediately when `open` becomes false.
- AI conversation titles strip hidden `<system-instruction>...</system-instruction>` blocks (the Command Palette wraps AI queries in them), while the full wrapped message is kept for runtime execution.
