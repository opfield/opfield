---
{
  "id": "94t2cjlq",
  "file_name": "94t2cjlq_gateway_ui_primitives",
  "tags": [
    "design-system",
    "frontend",
    "opfield",
    "shared-components",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.88,
  "created_at": 1782203110045,
  "updated_at": 1791851332992
}
---
Opfield frontend shared shell/table layer:
- Prefer packages/frontend/src/components/common/PanelShell.tsx for canonical bordered sections/cards with header, description/actions, and body hooks.
- Prefer SimpleTable for fixed modal/panel data, ResourceListLayout primitives for folder-style and main resource lists, DetailRow for label/value details, PageBackButton for the shared 36x36 back action, and the shared CodeEditor (bordered=false when PanelShell owns the border).
- Do not create domain-specific shells/tables/detail wrappers when these primitives can express the layout.
- Section header actions use the shared 36px height and shell padding; editor/log/console actions belong in PanelShell header actions where practical.
- Empty states, badges, rows, headers, and modal content use shared primitives/styles instead of local colors/sizes/wrappers.
- When folder-tree results are search-pruned, disable drag-and-drop reorder or correctly remap the full unfiltered ordering; reordering only visible rows can reshuffle hidden siblings.
- Verify touched files, frontend typecheck/lint, relevant UI tests, and git diff --check.
