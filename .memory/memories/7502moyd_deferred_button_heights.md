---
{
  "id": "7502moyd",
  "file_name": "7502moyd_deferred_button_heights",
  "tags": [
    "buttons",
    "deferred",
    "frontend",
    "ui-rules"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1791618967886,
  "updated_at": 1791618967886
}
---
Deferred by the user on 2026-10-10 ("когда соседняя сессия закончит займемся этим, нужно будет всё исправить"): bring every button to the standard height.

State on main (1af5a401d): the ui-rules check (`pnpm --filter frontend lint:ui-rules`, scripts/ui-rules) has rule `button-default-size` that forbids `size="sm"`, but 14 sm buttons are allowlisted:
- DatabaseBackupsTab.tsx: Run now ×2, Disable schedule, Restore and Remove per history row (Restore also overflows into the Size column — layout bug).
- AdminUserConfigDialog.tsx:508: Revoke per session in Active Sessions, next to a 36 px "Revoke all" (rows are tall enough; no reason for sm).
- AccessListDialog.tsx (Add rule, Add user), WebhookDialog.tsx (Add header), PostgresColumnSchemaDialog.tsx (Add column): section add actions.
- AvailabilityOperationsPanel.tsx (Retry), TerminalConsole.tsx (Pop out), AIToolCallBlock.tsx (Download chip, sm + h-7).
Rule gap: heights set through className (`h-7` etc.) on <Button> are not caught. The AI composer mode picker (h-7) is fine per the user: it does not read as a button.
Proposed (discussed, not yet approved in detail): remove sm from these, extend the rule to className heights with reasoned allowlist, decide icon sizes (icon 36, icon-sm 32 ×60, icon-xs 28 ×13, icon-lg 40). The design branch design/canvas-corrections is ~816 commits behind main, so its canvas shows stale UI.
