---
{
  "id": "p3e1ow76",
  "file_name": "p3e1ow76_logging_ui_defaults",
  "tags": [
    "housekeeping",
    "logging",
    "pages",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1787903456664,
  "updated_at": 1791851823089
}
---
Opfield logging and housekeeping UI contract updated on 2026-08-28:

- Logging list and Page Project detail headers do not show redundant plan/type badges. License enforcement remains in feature access and API behavior, not decorative page-title badges.
- Logging environment creation uses example placeholders for Name and Description.
- Every Logging environment header exposes Connection instructions. The dialog has SDK and API tabs and must reuse shared Dialog, Tabs, AnimatedHeight, and CopyCodeBlock primitives. SDK examples use @sqgateway/logger; API examples use Bearer ingest tokens with /api/logging/ingest and mention /api/logging/ingest/batch.
- Housekeeping defaults enable Structured Logs and Orphaned Volumes when settings are absent.
- ClickHouse Internals defaults enabled only when the persisted logging storage mode is local (Opfield-managed). It defaults disabled for external or missing storage ownership because cleanup targets ClickHouse system log tables that may be shared.
- Opfield Logs remains false because that storage category is unavailable.
- Existing persisted housekeeping values remain authoritative; defaults apply only when a setting is missing.
- Housekeeping run history uses the existing MAX_HISTORY cap of 20 both when saving and when returning history, so legacy oversized persisted arrays are bounded at the backend boundary.
- Helper/footer text shown in Settings for registry token authority and Housekeeping last-run/history controls uses the standard 14px text-sm size.
